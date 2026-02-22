# Instance Detail Page with Console Output

## Problem

When a tenant claims a workload, an instance is created and goes through a `starting` state before becoming `active`. During this time, the dashboard shows "starting" status in the workload tree but gives no visibility into what's happening — is the VM booting? Is the health check polling? Did something fail silently? And once it's running, there's no way to see what the entrypoint process is actually printing.

There's also no way to click on an instance to see its details or history.

## Current State

**Guest console output:**
- Firecracker captures serial console (`ttyS0`) output to a file on the host
- The guest init (`packages/guest-init/src/main.c`) redirects stdout/stderr → `/dev/console` → serial → host file
- In direct mode: `spawnFirecracker()` redirects Firecracker's stdout to `{instanceDir}/firecracker.console.log`
- In jailer mode: stdout is `"ignore"` — console output is lost (needs fixing)
- The console path is stored on `FirecrackerProcess.consolePath` and exposed via `handle.meta.consolePath` (direct mode only)
- `SnapshotManager.createGolden()` already reads this file on error (last 100 lines) for debugging, proving the path works
- The `Runtime` interface has no method to read console output

**Dashboard:**
- `WorkloadList` shows instances inline with short IDs and action buttons, but they're not clickable/linkable
- `WorkloadDetail` shows build logs (workload-level), not instance-level logs
- Routing: `/#/workloads`, `/#/workloads/:name`, `/#/nodes`, `/#/logs` — no instance route

**API:**
- `GET /instances/:id` returns instance detail (status, runtimeMeta, tenantId, etc.)
- `InstanceStateEvent` is emitted on the EventBus on state changes, but only contains the new status — no descriptive log line
- No way to read guest stdout/stderr from the API

## Plan

### 1. Runtime: Add `getConsolePath()` to the Runtime interface

**File:** `packages/core/src/runtime.ts`

```ts
/**
 * Returns the host-side path to the guest serial console log file.
 * Returns `null` if console output is not available for this instance.
 */
getConsolePath(handle: InstanceHandle): string | null;
```

This is a sync method — it just returns a path, no I/O. The caller reads the file.

**File:** `packages/runtime-firecracker/src/runtime.ts`

Implement by returning the stored `consolePath` from the `ManagedInstance`.

**File:** `packages/core/src/fake-runtime.ts`

Return `null`.

### 2. Runtime: Capture console output in jailer mode

**File:** `packages/runtime-firecracker/src/process.ts`

In `spawnJailer()`, redirect stdout to a console log file the same way `spawnFirecracker()` does. The file goes inside the chroot at `{chrootRoot}/firecracker.console.log`. Add `consolePath` to the `JailedProcess` interface.

```ts
// In spawnJailer():
const consolePath = join(chrootRoot, "firecracker.console.log");
const consoleFd = openSync(consolePath, "w");

const proc = Bun.spawn(
  ["sudo", opts.jailerPath, ...args],
  {
    stdout: consoleFd,
    stderr: "pipe",
  },
);
```

**File:** `packages/runtime-firecracker/src/runtime.ts`

Add `consolePath` field to `ManagedInstance`. Set it from the process in both `createDirect` and `createJailed`. Implement `getConsolePath()` by returning `managed.consolePath`.

### 3. API: Add `GET /instances/:id/logs` endpoint

**File:** `apps/api/src/routes/instances.ts`

```
GET /instances/:id/logs?tail=200
→ { lines: ConsoleLine[] }

interface ConsoleLine {
  /** Line number (0-indexed). */
  index: number;
  text: string;
}
```

Implementation:
1. Look up instance row to verify it exists
2. Build an `InstanceHandle` from the row
3. Call `runtime.getConsolePath(handle)` to get the file path
4. If `null`, return `{ lines: [] }`
5. Read the file, split by newlines, return the last `tail` lines (default 200)

For destroyed/hibernated instances the console file may no longer exist (VM cleaned up), so return empty lines gracefully.

### 4. API: Add `instance.log` event type to EventBus

**File:** `apps/api/src/event-bus.ts`

```ts
export interface InstanceLogEvent {
  type: "instance.log";
  instanceId: InstanceId;
  line: string;
  timestamp: string;
}
```

Add to `DomainEvent` union. This allows the dashboard to receive real-time console output via WebSocket.

### 5. API: Stream console output via `instance.log` events

**File:** `apps/api/src/instance-manager.ts`

After an instance starts successfully, begin tailing the console log file and emitting `instance.log` events for each new line.

```ts
private tailConsole(instanceId: InstanceId, handle: InstanceHandle): void {
  const consolePath = this.runtime.getConsolePath(handle);
  if (!consolePath) return;

  const watcher = fs.watch(consolePath, () => {
    // Read new lines since last offset, emit instance.log events
  });

  // Store watcher handle so it's cleaned up on destroy
}
```

Keep a byte offset per instance. On each file change event, read from the offset to EOF, split into lines, emit each as an `InstanceLogEvent`. Clean up the watcher on destroy/hibernate.

### 6. Dashboard: Add API client method

**File:** `apps/dashboard/src/api.ts`

```ts
export interface ConsoleLine {
  index: number;
  text: string;
}

fetchInstanceLogs: (id: string, tail?: number) =>
  get<{ lines: ConsoleLine[] }>(
    `/instances/${encodeURIComponent(id)}/logs${tail ? `?tail=${tail}` : ""}`
  ),
```

### 7. Dashboard: Create InstanceDetail page

**File:** `apps/dashboard/src/pages/InstanceDetail.tsx`

Layout:
```
← workloads                                     (back link)

Instance {shortId}

┌─────────────┐ ┌──────────┐ ┌────────────┐ ┌──────────┐
│ Instance ID │ │ Status   │ │ Workload   │ │ Tenant   │
│ abc123...   │ │ ● active │ │ openclaw   │ │ tenant-1 │
└─────────────┘ └──────────┘ └────────────┘ └──────────┘
┌─────────────┐ ┌──────────┐ ┌────────────┐
│ Node        │ │ Created  │ │ Claimed    │
│ node-1      │ │ 2/22 ... │ │ 2/22 ...   │
└─────────────┘ └──────────┘ └────────────┘

Console Output                                    [copy]
┌──────────────────────────────────────────────────────┐
│ init: workdir=/app                                   │
│ init: exec entrypoint: node                          │
│ init: health-agent pid=3                             │
│ Server listening on port 8080                        │
│ Connected to database                                │
│ GET /health 200 1ms                                  │
│                                                      │
│                                         ▼ auto-scroll│
└──────────────────────────────────────────────────────┘

[Connect]  [Hibernate]  [Destroy]
```

Shows guest stdout/stderr from the console log file. Initialized by fetching `GET /instances/:id/logs`, then updated in real-time via WebSocket `instance.log` events. Auto-scrolls. Copy button copies all lines.

During `starting` state, the console panel shows real-time output as the VM boots — init messages, entrypoint startup output, health check logs. This directly solves the "stuck on starting" problem.

Workload name is a link back to `/#/workloads/{name}`.

Action buttons (Connect, Hibernate, Destroy) match the workload list but rendered as full buttons.

### 8. Dashboard: Make instances clickable in WorkloadList

**File:** `apps/dashboard/src/pages/WorkloadList.tsx`

In the `InstanceRow` component, make the instance short ID a clickable link:

```tsx
<a
  href={`#/instances/${instance.instanceId}`}
  onClick={(e) => { e.preventDefault(); navigate(`/instances/${instance.instanceId}`); }}
  className="text-accent hover:underline"
>
  {shortId(instance.instanceId)}
</a>
```

Pass `navigate` through to `InstanceRow` (it's already available on `WorkloadGroup`).

### 9. Dashboard: Add route for instance detail

**File:** `apps/dashboard/src/app.tsx`

Add route matching for `/#/instances/:id`:

```ts
} else if ((params = matchRoute(path, "/instances/:id"))) {
  content = <InstanceDetail key={`${params.id}-${tick}`} id={params.id!} navigate={navigate} />;
}
```

The sidebar highlight stays on "workloads" since instances are children of workloads.

## File Change Summary

| File                                              | Change                                                             |
|---------------------------------------------------|--------------------------------------------------------------------|
| `packages/core/src/runtime.ts`                    | Add `getConsolePath()` to Runtime interface                        |
| `packages/core/src/fake-runtime.ts`               | Implement `getConsolePath()` returning `null`                      |
| `packages/runtime-firecracker/src/process.ts`     | Capture console output in jailer mode, add `consolePath` to `JailedProcess` |
| `packages/runtime-firecracker/src/runtime.ts`     | Store `consolePath` on `ManagedInstance`, implement `getConsolePath()` |
| `apps/api/src/event-bus.ts`                       | Add `InstanceLogEvent` type                                        |
| `apps/api/src/routes/instances.ts`                | Add `GET /instances/:id/logs`                                      |
| `apps/api/src/instance-manager.ts`                | Console tailing, emit `instance.log` events via EventBus           |
| `apps/dashboard/src/api.ts`                       | Add `fetchInstanceLogs()`                                          |
| `apps/dashboard/src/pages/InstanceDetail.tsx`     | New page (console output + metadata + actions)                     |
| `apps/dashboard/src/pages/WorkloadList.tsx`       | Make instance IDs clickable links                                  |
| `apps/dashboard/src/app.tsx`                      | Add `/instances/:id` route                                         |

## Not in scope

- Persisting console log lines to the database. The file-on-disk approach is sufficient — console output is tied to the VM lifetime and can be large.
- Instance-scoped activity log endpoint (the global activity log in the sidebar covers this).
- Log search/filtering in the dashboard.
- Log retention after instance destruction (files are cleaned up with the instance directory).
