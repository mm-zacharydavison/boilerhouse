# Network Hardening

## Problem

A security audit of the Boilerhouse network stack found 13 vulnerabilities (4 critical, 5 high, 4 medium). The two most impactful findings: `IptablesManager` and `ForwardProxy` are fully implemented and tested but never instantiated in `server.ts`. This means all network access controls declared in workload TOML (`network.access`, `network.allowlist`) are silently ignored. Guests have unrestricted network access in both dev and jailer modes.

### Current State

```
Guest VM (172.16.x.2)
  |
  v
TAP (172.16.x.1) — host namespace
  |
  +--> Host API :3000       (no INPUT rules)
  +--> Host SSH :22          (no INPUT rules)
  +--> Other TAP 172.16.y.1  (no inter-VM FORWARD rules)
  +--> eth0 --> Internet     (MASQUERADE only in jailer mode)
```

**Dev mode:** Zero iptables rules applied. `TapManager` creates TAP devices but nothing restricts traffic.

**Jailer mode:** `netns.ts` applies FORWARD + MASQUERADE rules per-namespace, but:
- No INPUT chain filtering (guest can reach host services via veth host IP)
- FORWARD rules are overly permissive (`-i vethHostName -j ACCEPT` — any destination)
- No DNS filtering, no rate limiting

## Findings Summary

| #    | Finding                                   | Severity | Status              | File(s)                                |
| ---- | ----------------------------------------- | -------- | ------------------- | -------------------------------------- |
| 1.1  | No INPUT chain filtering                  | CRITICAL | Not mitigated       | `netns.ts:158-170`, `tap.ts`           |
| 1.2  | No inter-VM isolation in dev mode         | CRITICAL | Not mitigated       | `tap.ts`                               |
| 1.3  | iptables rules generated but never applied| CRITICAL | Code exists, unwired| `iptables.ts`, `server.ts`             |
| 1.4  | No ARP/IP spoofing prevention             | HIGH     | Not implemented     | `tap.ts`, `netns.ts`                   |
| 1.5  | Jailer FORWARD rules overly permissive    | MEDIUM   | Partial             | `netns.ts:159-170`                     |
| 2.1  | ForwardProxy never instantiated           | CRITICAL | Code exists, unwired| `proxy/proxy.ts`, `server.ts`          |
| 2.2  | DNAT proxy redirect rules never applied   | CRITICAL | Code exists, unwired| `iptables.ts`                          |
| 2.3  | DNS bypass not addressed                  | HIGH     | Not implemented     | —                                      |
| 2.4  | Non-HTTP protocol bypass                  | HIGH     | Not implemented     | —                                      |
| 2.5  | Guest can use direct IPs to bypass proxy  | MEDIUM   | Not implemented     | —                                      |
| 3.1  | Default firewall policy is ACCEPT         | HIGH     | Not mitigated       | —                                      |
| 3.2  | No rate limiting or DDoS protection       | MEDIUM   | Not implemented     | —                                      |
| 3.3  | Firecracker socket permissions            | HIGH     | Dev mode only       | `process.ts`                           |
| 3.4  | Overly broad sudoers rules               | MEDIUM   | Not mitigated       | `setup-firecracker.sh:185-193`         |
| 3.5  | Snapshot files unencrypted                | MEDIUM   | Not mitigated       | —                                      |

## Design Decisions

### D1: IptablesManager executes its own rules

Currently `IptablesManager.setupForInstance()` returns `string[]` and expects the caller to execute them. This is the root cause of finding 1.3 — nobody executes the returned strings. Change `IptablesManager` to execute its own rules via `Bun.spawn(["sudo", "iptables", ...])`, matching the pattern already used in `netns.ts` and `tap.ts`. The returned strings remain useful for logging/debugging but execution is no longer the caller's responsibility.

### D2: NetworkManager orchestrates all network setup per instance

Rather than expecting `server.ts` to coordinate TAP creation, iptables rules, and proxy registration for every instance, introduce a single `NetworkManager` class that owns the full network lifecycle for an instance. This is the integration point between existing components:
- `TapManager` or `NetnsManagerImpl` (device creation)
- `IptablesManager` (firewall rules)
- `ForwardProxy` (domain-filtered egress)

### D3: ForwardProxy starts unconditionally

The proxy listens on a random ephemeral port and is always running. Instances with `network.access = "restricted"` get DNAT rules pointing to it, plus a `proxy.addInstance(guestIp, allowlist)` registration. Instances with other access modes don't get DNAT rules, so the proxy is idle but harmless.

### D4: Dev mode gets the same firewall rules as jailer mode

Dev mode is currently a security free-for-all. After this work, dev mode applies the same iptables rules as jailer mode (INPUT filtering, inter-VM isolation, proxy DNAT). The only difference is TAP devices live in the host namespace instead of per-VM network namespaces.

### D5: Default-deny FORWARD and INPUT policy

Set `iptables -P FORWARD DROP` and `iptables -P INPUT DROP` at startup, with explicit ACCEPT rules for:
- INPUT: API port from the management network, loopback, ESTABLISHED/RELATED
- FORWARD: only per-instance rules added by `IptablesManager`

This converts the system from fail-open to fail-closed.

## Implementation Plan

### Phase 1: Make IptablesManager Self-Executing

**Files:** `apps/api/src/network/iptables.ts`, `apps/api/src/network/iptables.test.ts`

Change `IptablesManager` to execute iptables commands directly instead of returning strings. Add an `execute` method and call it from `setupForInstance` / `teardownForInstance`.

```ts
export class IptablesManager {
  /**
   * Applies iptables rules for the given instance and access level.
   * Executes them immediately via sudo and stores them for teardown.
   */
  async setupForInstance(
    instanceId: InstanceId,
    tap: TapDevice,
    guestIp: string,
    access: NetworkAccess,
    options: SetupOptions = {},
  ): Promise<void> {
    const rules = this.buildRules(instanceId, tap, guestIp, access, options);
    await this.applyRules(rules);
    this.instanceRules.set(instanceId, rules);
  }

  /**
   * Removes all iptables rules for the given instance.
   */
  async teardownForInstance(instanceId: InstanceId): Promise<void> {
    const rules = this.instanceRules.get(instanceId);
    if (!rules) return;
    const teardown = rules.map((r) => r.replace(" -A ", " -D "));
    // Best-effort: don't throw on individual rule deletion failures
    await this.applyRules(teardown, { bestEffort: true });
    this.instanceRules.delete(instanceId);
  }

  private async applyRules(
    rules: string[],
    opts?: { bestEffort?: boolean },
  ): Promise<void> {
    for (const rule of rules) {
      const args = rule.split(" "); // ["iptables", "-A", ...]
      const proc = Bun.spawn(["sudo", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0 && !opts?.bestEffort) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`iptables failed (exit ${exitCode}): ${rule}\n${stderr}`);
      }
    }
  }
}
```

The existing unit tests need updating since `setupForInstance` now returns `Promise<void>` instead of `string[]`. Add a `buildRules()` method that returns the raw strings for testing rule generation without requiring sudo.

Also update `IptablesManager` to handle the additional rules from Phase 2 and 3.

### Phase 2: Add INPUT and Inter-VM Isolation Rules

**Files:** `apps/api/src/network/iptables.ts`

Extend `IptablesManager` with:

1. **INPUT chain DROP for guest traffic** — block guests from reaching host services:

```
iptables -A INPUT -i <tap> -j DROP
```

In jailer mode, the equivalent applies to the veth host interface. This is the single highest-impact rule — it blocks finding 1.1.

2. **Inter-VM FORWARD isolation (dev mode)** — block traffic between TAP devices:

```
iptables -A FORWARD -i <tap_A> -o <tap_B> -j DROP
```

In practice, the default-deny FORWARD policy (Phase 5) makes this implicit, but explicit per-TAP rules provide defense-in-depth before Phase 5 lands.

3. **MAC address filtering** — prevent MAC spoofing:

```
iptables -A FORWARD -i <tap> -m mac ! --mac-source <expected_mac> -j DROP
```

Add these to the `buildRules()` output, keyed on access mode:
- `"none"`: INPUT DROP on TAP + FORWARD DROP on TAP (total isolation)
- `"outbound"`: INPUT DROP on TAP + FORWARD ACCEPT to eth0 only + MASQUERADE + MAC filter
- `"restricted"`: same as outbound + DNAT 80/443 to proxy + FORWARD DROP for non-proxy ports

### Phase 3: Wire ForwardProxy into Server Startup

**Files:** `apps/api/src/server.ts`, `apps/api/src/routes/deps.ts`

1. Instantiate `ForwardProxy` with port 0 (ephemeral) and `.start()` it before building the app.
2. Pass the proxy's port to `IptablesManager` for DNAT rules.
3. Add proxy to `RouteDeps` so routes can register/deregister instances.

```ts
// server.ts additions:
import { ForwardProxy } from "./proxy/proxy";
import { IptablesManager } from "./network/iptables";

const proxy = new ForwardProxy({ port: 0 });
await proxy.start();
console.log(`Forward proxy listening on port ${proxy.port}`);

const iptablesManager = new IptablesManager();
```

### Phase 4: NetworkManager — Per-Instance Network Lifecycle

**New file:** `apps/api/src/network/manager.ts`

Orchestrates the full network setup/teardown for each instance. Called by `InstanceManager` during create/destroy/restore.

```ts
import type { InstanceId, NetworkAccess, Workload } from "@boilerhouse/core";
import type { TapDevice } from "./tap";
import type { TapManager } from "./tap";
import type { IptablesManager } from "./iptables";
import type { ForwardProxy } from "../proxy/proxy";

interface NetworkSetup {
  guestIp: string;
  tap: TapDevice;
}

export class NetworkManager {
  constructor(
    private readonly tapManager: TapManager,
    private readonly iptables: IptablesManager,
    private readonly proxy: ForwardProxy,
  ) {}

  /**
   * Full network setup for a new instance:
   * 1. Create TAP device
   * 2. Apply iptables rules based on access mode
   * 3. Register with proxy if restricted mode
   */
  async setup(
    instanceId: InstanceId,
    workload: Workload,
  ): Promise<NetworkSetup> {
    const tap = await this.tapManager.create(instanceId);
    const guestIp = deriveGuestIp(tap.ip);
    const access = workload.network.access;

    await this.iptables.setupForInstance(instanceId, tap, guestIp, access, {
      proxyPort: this.proxy.port,
      portMappings: workload.network.expose?.map((e) => ({
        hostPort: e.host_range[0],
        guestPort: e.guest,
      })),
    });

    if (access === "restricted" && workload.network.allowlist) {
      this.proxy.addInstance(guestIp, workload.network.allowlist);
    }

    return { guestIp, tap };
  }

  /**
   * Full network teardown for a destroyed instance.
   */
  async teardown(
    instanceId: InstanceId,
    guestIp: string,
    tap: TapDevice,
  ): Promise<void> {
    this.proxy.removeInstance(guestIp);
    await this.iptables.teardownForInstance(instanceId);
    await this.tapManager.destroy(tap);
  }
}
```

For jailer mode, a parallel `JailedNetworkManager` wraps `NetnsManagerImpl` instead of `TapManager`. The `netns.ts` rules (FORWARD + MASQUERADE) move into `IptablesManager` so all firewall logic is centralized.

### Phase 5: Default-Deny Firewall Policy

**New file:** `apps/api/src/network/firewall-init.ts`

Run once at server startup, before any instances are created. Sets chain policies and base rules.

```ts
export async function initFirewall(config: {
  /** Port the API server listens on. */
  apiPort: number;
  /** Host-facing interface for NAT. @default "eth0" */
  uplinkInterface?: string;
}): Promise<void> {
  const uplink = config.uplinkInterface ?? "eth0";

  await sudo("iptables", "-P", "FORWARD", "DROP");
  await sudo("iptables", "-P", "INPUT", "DROP");

  // Allow loopback
  await sudo("iptables", "-A", "INPUT", "-i", "lo", "-j", "ACCEPT");

  // Allow established connections
  await sudo("iptables", "-A", "INPUT",
    "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT");

  // Allow API port from management network
  await sudo("iptables", "-A", "INPUT",
    "-p", "tcp", "--dport", String(config.apiPort),
    "-i", uplink, "-j", "ACCEPT");

  // Allow FORWARD for established (return traffic)
  await sudo("iptables", "-A", "FORWARD",
    "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT");
}
```

This converts the entire system from fail-open to fail-closed. Any iptables rule that fails to load results in the guest having *no* access instead of *full* access.

### Phase 6: DNS Filtering for Restricted Mode

**Files:** `apps/api/src/network/iptables.ts`

For `"restricted"` access mode, add rules that block direct DNS and redirect to a local filtering resolver. Two options:

**Option A — Block DNS entirely:**
The proxy handles DNS resolution for the guest, so the guest doesn't need direct DNS.

```
iptables -A FORWARD -i <tap> -p udp --dport 53 -j DROP
iptables -A FORWARD -i <tap> -p tcp --dport 53 -j DROP
```

**Option B — Redirect DNS to a local resolver:**
Run a DNS-over-HTTPS proxy (e.g., `dnscrypt-proxy`) that only resolves domains in the workload allowlist.

Option A is simpler and sufficient if the forward proxy handles all resolution. Recommend Option A first, consider Option B if workloads need DNS for non-HTTP services.

For `"outbound"` and `"none"` modes, DNS rules aren't needed (outbound has unrestricted access, none has no network at all).

### Phase 7: Port Restriction for Restricted Mode

**Files:** `apps/api/src/network/iptables.ts`

For `"restricted"` mode, the current DNAT rules only catch ports 80 and 443. Traffic on any other port bypasses the proxy via MASQUERADE. Fix by only allowing FORWARD for ports 80/443 when in restricted mode:

```
# Only allow HTTP/HTTPS through proxy
iptables -A FORWARD -i <tap> -p tcp --dport 80 -j ACCEPT
iptables -A FORWARD -i <tap> -p tcp --dport 443 -j ACCEPT
# Everything else is dropped by default FORWARD DROP policy
```

Combined with Phase 5's default-deny FORWARD, this means restricted guests can only reach the internet via the proxy.

### Phase 8: Harden netns.ts Rules (Jailer Mode)

**Files:** `packages/runtime-firecracker/src/netns.ts`

Replace the current overly-permissive FORWARD rules with scoped rules. The current:

```ts
// Lines 159-170: too broad
await sudoExec(["iptables", "-A", "FORWARD", "-i", vethHostName, "-j", "ACCEPT"]);
```

Becomes:

```ts
// Only allow forwarding to the uplink interface, not to other veths/TAPs
await sudoExec(["iptables", "-A", "FORWARD",
  "-i", vethHostName, "-o", uplinkInterface, "-j", "ACCEPT"]);
```

Also add INPUT DROP for the veth host interface:

```ts
await sudoExec(["iptables", "-A", "INPUT", "-i", vethHostName, "-j", "DROP"]);
```

Move the iptables rule generation out of `netns.ts` and into `IptablesManager` so all firewall logic is in one place. `netns.ts` should only handle namespace/TAP/veth creation.

### Phase 9: Enable rp_filter on TAP/Veth Interfaces

**Files:** `apps/api/src/network/tap.ts`, `packages/runtime-firecracker/src/netns.ts`

After creating each TAP or veth interface, enable reverse path filtering:

```ts
// In TapManager.create(), after creating the TAP:
await Bun.spawn(["sudo", "sysctl", "-w",
  `net.ipv4.conf.${device.name}.rp_filter=1`]);

// In NetnsManagerImpl.create(), after creating the veth:
await sudoExec(["sysctl", "-w",
  `net.ipv4.conf.${vethHostName}.rp_filter=1`]);
```

This prevents IP spoofing — the kernel drops packets with source IPs that don't match the expected route for the interface they arrived on.

### Phase 10: Firecracker Socket Permissions

**Files:** `packages/runtime-firecracker/src/process.ts`

After the Firecracker process creates its API socket, chmod it to 0600. In dev mode this prevents other users on the host from controlling VMs.

```ts
// In spawnFirecracker(), after waitForSocket():
import { chmodSync } from "node:fs";
chmodSync(socketPath, 0o600);
```

In jailer mode the socket is inside the chroot with restricted UID, so this is already handled.

### Phase 11: Rate Limiting (connlimit)

**Files:** `apps/api/src/network/iptables.ts`

Add connection rate limiting per-TAP to prevent a single VM from flooding the network:

```
iptables -A FORWARD -i <tap> -m connlimit --connlimit-above 1000 -j DROP
iptables -A FORWARD -i <tap> -m hashlimit \
  --hashlimit-name vm_<instanceId> \
  --hashlimit-above 10000/sec \
  --hashlimit-burst 15000 \
  --hashlimit-mode srcip \
  -j DROP
```

Exact thresholds should be configurable per-workload (add `network.rate_limit` to the workload schema later). Start with generous defaults that prevent abuse without affecting normal operation.

### Phase 12: Tighten Sudoers Rules

**Files:** `scripts/setup-firecracker.sh`

Replace wildcard sudoers entries with specific argument patterns:

```diff
-${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip netns *
-${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip link *
-${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip addr *
-${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip tuntap *
-${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip netns add fc-*
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip netns delete fc-*
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip netns exec fc-* *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip netns list
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip link add *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip link set *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip link delete *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip link show *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip addr add *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip tuntap add *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables -A *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables -D *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables -P *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables -t nat *
+${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/sysctl -w net.ipv4.*
```

This limits the blast radius if the API server process is compromised. A compromised process can still manipulate boilerhouse-related network state, but cannot run arbitrary `ip` or `iptables` commands (e.g., `ip route add`, `iptables -F`).

## File Change Summary

| File                                              | Change                                                  |
| ------------------------------------------------- | ------------------------------------------------------- |
| `apps/api/src/network/iptables.ts`                | Self-executing, INPUT rules, inter-VM rules, MAC filter |
| `apps/api/src/network/iptables.test.ts`           | Update for async API, add rule content tests            |
| `apps/api/src/network/manager.ts`                 | **New** — Orchestrates TAP + iptables + proxy per-VM    |
| `apps/api/src/network/firewall-init.ts`           | **New** — Default-deny policy at startup                |
| `apps/api/src/network/tap.ts`                     | Add rp_filter sysctl after TAP creation                 |
| `apps/api/src/server.ts`                          | Wire ForwardProxy, IptablesManager, NetworkManager      |
| `apps/api/src/routes/deps.ts`                     | Add proxy + networkManager to RouteDeps                 |
| `packages/runtime-firecracker/src/netns.ts`       | Move iptables out, add INPUT DROP, scope FORWARD rules  |
| `packages/runtime-firecracker/src/process.ts`     | chmod 0600 on socket after creation                     |
| `scripts/setup-firecracker.sh`                    | Tighten sudoers entries                                 |

## Phase Priority

Phases are ordered by security impact. Phases 1-5 close all critical findings.

| Phase | Closes Findings | Effort |
| ----- | --------------- | ------ |
| 1     | 1.3             | Small  |
| 2     | 1.1, 1.2, 1.4   | Medium |
| 3     | 2.1, 2.2        | Small  |
| 4     | —               | Medium |
| 5     | 3.1             | Small  |
| 6     | 2.3             | Small  |
| 7     | 2.4, 2.5        | Small  |
| 8     | 1.5             | Small  |
| 9     | 1.4 (defense in depth) | Small |
| 10    | 3.3             | Small  |
| 11    | 3.2             | Medium |
| 12    | 3.4             | Small  |

## Open Questions

- **Uplink interface detection:** Rules currently hardcode `eth0`. Should auto-detect via `ip route show default` or make configurable via `UPLINK_INTERFACE` env var. Both approaches are simple; env var is more explicit.
- **Proxy listen address:** Currently `0.0.0.0`. Should bind to `127.0.0.1` since only DNAT'd traffic from local guests should reach it. But if the proxy needs to be reachable from network namespaces (jailer mode), it needs to listen on the veth host IPs or use `0.0.0.0`. Needs testing.
- **Workload-level rate limits:** Phase 11 uses hardcoded defaults. Adding `network.rate_limit` to the workload TOML schema is a separate task. The defaults should be generous enough to not break normal workloads.
- **Snapshot encryption (finding 3.5):** Not addressed in this plan. Snapshot encryption at rest is orthogonal to network hardening and requires its own design (key management, performance impact on snapshot/restore). Track separately.
