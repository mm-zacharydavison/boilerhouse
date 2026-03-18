# Podman Runtime Security Hardening

## Threat Model

The API server is the access-control boundary between clients and the rootful Podman daemon.
Clients cannot reach Podman directly — all operations go through the API, which enforces
ownership (tenants can only checkpoint/restore their own instances). This gives us two
distinct threat layers to defend:

1. **Lateral movement** — one tenant accessing another's checkpoint (API-level, largely handled
   by DB ownership tracking).
2. **Vertical escalation** — a compromised API server (or supply-chain dependency) abusing the
   raw Podman socket to perform operations outside the intended set (e.g. create a privileged
   container, restore an unsigned archive, mount host paths).

The mitigations below address both layers.

---

## Items

### 1 — Archive HMAC verification

**Risk addressed:** C2 — archive injection on restore.

**Problem:** `PodmanRuntime.restore()` reads a tar.gz from disk and sends it directly to the
Podman checkpoint-restore API with no integrity check. Any process that can write to
`snapshotDir` can replace or tamper with an archive and have it restored as root.

**Fix:** Compute an HMAC-SHA256 of the archive immediately after checkpoint and store it in the
`snapshots` table. Verify it before every restore.

```
checkpoint → HMAC-SHA256(archive, serverSecret) → stored in DB as snapshots.archiveHmac
restore    → read archive from disk
           → recompute HMAC
           → compare to DB value — reject if mismatch
           → then call podman
```

`serverSecret` is a random value in the environment (not co-located with archives on disk).
This means:
- Replacing the archive file → HMAC recomputation fails → rejected.
- Updating the DB row too → attacker needs the server secret → still rejected.

**Schema change:** add `archive_hmac TEXT NOT NULL` column to `snapshots` table.

**Code changes:**
- `packages/runtime-podman/src/runtime.ts` — `snapshot()` computes and returns HMAC;
  `restore()` receives expected HMAC and verifies before calling `restoreContainer`.
- `apps/api/src/instance-manager.ts` — passes HMAC through from snapshot row to restore call.
- `packages/db/src/schema.ts` + new migration — add `archive_hmac` column.

---

### 2 — Explicit container create enforcement

**Risk addressed:** H2 (`netns: host`), H3 (privileged port binding).

**Problem:** Security properties of created containers are currently implicit consequences of
how `runtime.ts` builds the spec. Future changes could accidentally regress them. There is no
positive assertion that containers are non-privileged.

**Fix:** Add explicit guards in `PodmanRuntime.create()` before calling `createContainer`:

- Assert all `portmappings` entries have `host_port === 0` (kernel-assigned; never < 1024).
- Assert `netns.nsmode` is never `"host"`.
- Explicitly include `"privileged": false` in `buildCreateBody()` so it is a positive
  statement, not a default.

These are small guards that document security intent and prevent regressions.

---

### 3 — Snapshot directory and archive permissions

**Risk addressed:** H1 — process memory dumps readable by unintended parties.

**Problem:** `snapshotDir` and individual archive files inherit the process umask. CRIU archives
contain full process memory (heap, stack, open FDs, TLS session state). If `snapshotDir` is
group- or world-readable, tenant secrets are exposed to any local process on the host.

**Fix:**
- At API server startup, assert or enforce `chmod 700` on `snapshotDir`.
- When writing each archive in `snapshot()`, set explicit `mode: 0o600` so the file is
  readable only by the API server user.

---

### 4 — Systemd socket TOCTOU fix

**Risk addressed:** M1 — race between socket creation and permission assignment.

**Problem:** Between when Podman creates the socket and when permissions are set, the socket
has whatever permissions Podman assigns (depends on the process umask). On permissive systems
this could be `0666`, making the socket briefly world-accessible.

**Fix:** Set `UMask=0117` in `deploy/boilerhouse-podmand.service`. With this umask, both the podman
socket and runtime socket are created with restrictive permissions natively. The podman socket
is now root-only (0600) since `boilerhouse-podmand` manages podman as a child process. Only the
runtime socket needs group access (0660).

---

### 5 — Systemd capability bounding set

**Risk addressed:** M4 — unrestricted root capabilities on the daemon service.

**Problem:** The service runs as root with all Linux capabilities. A Podman CVE or CRIU
vulnerability that allows code execution inside the daemon process gets full root with no
restrictions.

**Fix:** Bound the service to only the capabilities CRIU requires:

```ini
[Service]
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SYS_PTRACE CAP_NET_ADMIN CAP_SYS_CHROOT CAP_CHOWN CAP_DAC_READ_SEARCH CAP_FOWNER CAP_KILL
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/run/boilerhouse /var/lib/containers /var/run/containers /tmp
```

This does not restrict CRIU's intended operations but caps what an exploit could escalate to.

---

### 6 — Privilege-separating proxy daemon (`boilerhouse-podmand`) ✅ Implemented

**Risk addressed:** C1 — the API server has full access to the raw Podman socket (a root API
with no per-operation restrictions). Any code in the API server process — including transitive
npm/bun dependencies — can create privileged containers, pull arbitrary images, or mount host
paths.

**Problem (five whys):**
1. Why is the socket dangerous? → Full Podman API access = root on the host.
2. Why can't we restrict what the socket exposes? → Podman exposes its entire Libpod API on
   one socket with no per-endpoint authorization.
3. Why does this matter if the API server is trusted? → The API server's dependency tree is
   not zero-risk; a supply-chain compromise or memory-corruption vulnerability escalates
   directly to root.
4. Why can't group membership alone contain this? → Group membership is binary — all processes
   running under the API server's GID get full access, including subprocesses and worker threads.
5. Why is there no fallback? → No auth token, no TLS mutual auth, no operation allowlist.
   Filesystem permissions are the only control.

**Fix:** Introduce a narrow proxy daemon that sits between the API server and Podman. The raw
Podman socket becomes `600` (root-only). Only the proxy can reach it. The API server connects
to the proxy's restricted socket instead.

```
API Server (unprivileged)
  └─ /run/boilerhouse/runtime.sock  (660, boilerhouse group)
       └─ boilerhouse-podmand (root, minimal capabilities)
            └─ podman system service (child process)
                 └─ /run/boilerhouse/podman.sock  (600, root-only)
```

The proxy exposes only the operations the API server actually needs:

| Operation    | Podman calls                               | Proxy enforcement                           |
|--------------|--------------------------------------------|---------------------------------------------|
| `create`     | `images/pull`, `containers/create`         | Enforce `privileged:false`, `host_port:0`   |
| `start`      | `containers/{id}/start`                    | Only containers the proxy created           |
| `checkpoint` | `containers/{id}/checkpoint`               | Only known containers; signs archive (HMAC) |
| `restore`    | `containers/restore`                       | Verifies archive HMAC before restore        |
| `destroy`    | `containers/{id}?force=true`               | Only known containers                       |
| `exec`       | `containers/{id}/exec`, `exec/{id}/start`  | Only known containers                       |

**Key property:** even a fully compromised API server can only perform the six operations
above, against containers it registered. It cannot create a privileged container, restore an
unsigned archive, or operate on containers outside its registry.

The proxy maintains its own container registry (in-memory or small SQLite). On `create`, it
records the new container ID. `checkpoint` and `restore` refuse to operate on unknown IDs.
This is ownership enforcement at the privilege boundary, not only in the application layer.

**Implementation:** `apps/boilerhouse-podmand/` contains the daemon. It manages the `podman system
service` as a child process (no separate systemd unit needed). The runtime package provides
`ContainerBackend` interface with `DirectBackend` (direct podman) and `DaemonBackend`
(HTTP-over-Unix-socket to daemon). `PodmanRuntime` selects backend via `config.daemonSocket`.
Deployment: `deploy/boilerhouse-podmand.service`, `scripts/start-boilerhouse-podmand.sh`.

---

## Priority and Effort

| # | Item                                    | Effort  | Risk mitigated          |
|---|-----------------------------------------|---------|-------------------------|
| 1 | Archive HMAC verification               | Small   | C2 — archive injection  |
| 2 | Explicit container create enforcement   | Trivial | H2 netns, H3 ports      |
| 3 | Snapshot dir/file permissions           | Trivial | H1 — memory dump leaks  |
| 4 | Systemd `UMask=0117` TOCTOU fix         | Trivial | M1 — socket race        |
| 5 | Systemd capability bounding set         | Small   | M4 — unrestricted root  |
| 6 | Proxy daemon (`boilerhouse-podmand`)            | Medium  | C1 — full root socket   |

Items 2–4 are one-liners or single-file changes with no schema impact. Item 1 requires a DB
migration. All items are now implemented.
