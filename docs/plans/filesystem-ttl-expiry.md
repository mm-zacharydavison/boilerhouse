# Filesystem-Based TTL Expiry

## Problem

Boilerhouse currently relies on explicit API calls to release containers. For use cases like messaging (WhatsApp, Telegram), where a container is claimed per-conversation and should be released after a period of inactivity, there is no automatic mechanism to detect idle containers and return them to the pool.

We need a way to automatically release claimed containers when the tenant stops using them, without requiring any modifications to the container image. The filesystem is the natural signal — if the container hasn't written to its state directory in a while, the tenant is idle.

## Why Host-Side Filesystem Watching

Three approaches were considered:

| Approach                          | Container-agnostic? | Accurate? | Notes                                     |
| --------------------------------- | ------------------- | --------- | ----------------------------------------- |
| Container signals via API         | No                  | Yes       | Requires container to know about BH API   |
| Container writes heartbeat file   | No                  | Yes       | Requires container to adopt a convention   |
| **Host watches state directory**  | **Yes**             | **Yes**   | No container modifications needed          |

Host-side watching preserves boilerhouse's core design principle: works with any container image without modifications.

### Why This Is Accurate

During the window where idle TTL matters (container is claimed and active), the only process writing to the state directory is the container itself:

- **On claim:** sync downloads state (host writes) — but TTL timer starts *after* claim completes
- **During active use:** periodic sync *uploads* from the directory (reads only, no writes)
- **On release:** sync uploads final state (reads only)

The only edge case is **bisync** — remote changes synced back down would reset the TTL. This is arguably correct behaviour, since it means there's new data the tenant hasn't processed yet.

## Design

### New Config: `fileIdleTtlMs`

Add an optional `file_idle_ttl_ms` field to the pool configuration in the workload YAML:

```yaml
pool:
  min_size: 2
  max_size: 20
  file_idle_ttl_ms: 300000  # 5 minutes of filesystem inactivity triggers release
```

When set, boilerhouse watches the state directory of each claimed container and releases it if no writes occur within the TTL window. When unset (default), the existing behaviour is preserved — containers are only released via explicit API calls or the existing `idleTimeoutMs` eviction.

### `IdleReaper` Component

A new `IdleReaper` class that monitors claimed containers for filesystem inactivity.

```
┌─────────────────────────────────────────────────┐
│ IdleReaper                                      │
│                                                 │
│   For each claimed container with fileIdleTtlMs │
│   configured:                                   │
│                                                 │
│   1. fs.watch(stateDir) via inotify             │
│   2. On write event → reset idle timer          │
│   3. On timer expiry → trigger release          │
│                                                 │
│   Hooks into:                                   │
│   - pool.acquireForTenant() → start watching    │
│   - pool.releaseForTenant() → stop watching     │
│   - syncCoordinator.onRelease() → final sync    │
│                                                 │
└─────────────────────────────────────────────────┘
```

#### Why `fs.watch` (inotify) Instead of Polling

- **Immediate detection** — the kernel notifies on write, no polling interval delay
- **Zero CPU when idle** — inotify is event-driven, no periodic stat() calls
- **Lower latency on TTL expiry** — timer starts counting from the exact moment of the last write
- **Scales well** — inotify handles thousands of watched directories efficiently

#### Recursive Watching

`fs.watch` with `{ recursive: true }` covers the entire state directory tree. This handles workloads that write to nested subdirectories without needing to know the internal file layout.

Note: Bun's `fs.watch` supports recursive watching on Linux via inotify.

### Integration Points

#### On Claim

When `ContainerPool.acquireForTenant()` completes (after sync download finishes):

1. Check if pool has `fileIdleTtlMs` configured
2. If so, call `idleReaper.watch(containerId, stateDir, fileIdleTtlMs)`
3. The reaper starts an `fs.watch` on the state directory and sets an initial idle timer

#### On Write Detected

When inotify fires for any file change in the state directory:

1. Clear the existing idle timer
2. Reset a new timer for `fileIdleTtlMs` from now
3. Update `lastActivity` in the claims table (debounced — at most once per second to avoid DB thrash)

#### On Timer Expiry

When the idle timer fires (no writes for `fileIdleTtlMs`):

1. Log the expiry event
2. Trigger the standard release flow: `syncCoordinator.onRelease()` then `pool.releaseForTenant()`
3. The reaper cleans up its own watcher as part of the release

#### On Explicit Release

When `releaseForTenant()` is called via the API (before TTL):

1. `idleReaper.unwatch(containerId)` — closes the fs.watch and clears the timer
2. Normal release flow proceeds

### Metrics

| Metric                                    | Type    | Labels           | Description                                   |
| ----------------------------------------- | ------- | ---------------- | --------------------------------------------- |
| `boilerhouse_idle_reaper_watches_active`  | Gauge   | `pool_id`        | Number of containers currently being watched   |
| `boilerhouse_idle_reaper_expirations`     | Counter | `pool_id`        | Containers released due to filesystem idle TTL |
| `boilerhouse_idle_reaper_resets`          | Counter | `pool_id`        | Timer resets from filesystem activity          |

### Recovery

On startup, `IdleReaper` needs to restore watches for containers that were claimed before the restart:

1. During `poolRegistry.restoreFromDb()`, after restoring claimed containers
2. For each claimed container in a pool with `fileIdleTtlMs` configured:
   - `stat()` the state directory to get last mtime
   - If `now - mtime > fileIdleTtlMs` — release immediately (was idle through the restart)
   - Otherwise — start watching with remaining TTL (`fileIdleTtlMs - (now - mtime)`)

## Implementation

### Files to Create

#### `apps/api/lib/container/idle-reaper.ts`

The `IdleReaper` class:

```typescript
interface WatchedContainer {
  containerId: ContainerId
  tenantId: TenantId
  poolId: PoolId
  stateDir: string
  ttlMs: number
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout>
  lastWrite: number  // timestamp of last detected write
}

class IdleReaper {
  private watches: Map<ContainerId, WatchedContainer>
  private db: DrizzleDb
  private onExpiry: (containerId: ContainerId, tenantId: TenantId, poolId: PoolId) => Promise<void>

  watch(containerId, tenantId, poolId, stateDir, ttlMs): void
  unwatch(containerId): void
  restoreWatch(containerId, tenantId, poolId, stateDir, ttlMs, lastMtime): void
  shutdown(): void
}
```

Key implementation details:
- `watch()` creates an `fs.watch(stateDir, { recursive: true })` and starts the idle timer
- On `'change'` events, debounce the `lastActivity` DB update (max once per second)
- `onExpiry` callback is provided by the caller (pool registry or coordinator) to trigger the release flow
- `shutdown()` closes all watchers and clears all timers

### Files to Modify

#### `packages/core/src/schemas/workload.ts`

Add `file_idle_ttl_ms` to the pool config schema:

```typescript
// In poolConfigSchema
file_idle_ttl_ms: z.number().positive().optional()
```

#### `apps/api/lib/container/pool.ts`

- Add `fileIdleTtlMs` to `ContainerPoolConfig`
- Expose it so the idle reaper can read the config per pool

#### `apps/api/lib/pool/registry.ts`

- Create `IdleReaper` instance during startup
- After `acquireForTenant()`, call `idleReaper.watch()` if pool has `fileIdleTtlMs`
- On release (both explicit and TTL-triggered), call `idleReaper.unwatch()`
- During `restoreFromDb()`, restore watches for claimed containers
- On `shutdown()`, call `idleReaper.shutdown()`

#### `packages/db/src/schema.ts`

Add `fileIdleTtlMs` to the pools table:

```typescript
fileIdleTtlMs: integer('file_idle_ttl_ms'),
```

#### `apps/api/lib/metrics/pool.ts`

Add the three new metrics for the idle reaper.

### DB Migration

One new nullable column on the `pools` table:

```sql
ALTER TABLE pools ADD COLUMN file_idle_ttl_ms INTEGER;
```

## Edge Cases

### Container writes during sync download (onClaim)

The idle reaper should only be started *after* the claim flow completes (including sync download). This avoids counting sync-engine writes as tenant activity.

Sequence: `acquireForTenant()` → `syncCoordinator.onClaim()` → `idleReaper.watch()`

### Rapid file changes (write storms)

The debounce on `lastActivity` DB updates (max once per second) prevents DB thrash. The timer reset itself is cheap (just `clearTimeout` + `setTimeout`).

### State directory deleted or moved

If the state directory is removed (e.g., container destroyed), `fs.watch` emits an error. The error handler should call `unwatch()` and log a warning — the container is already gone.

### inotify limits

Linux defaults to 8192 inotify watches per user (`/proc/sys/fs/inotify/max_user_watches`). With recursive watching, each subdirectory counts as one watch. For deployments with many containers or deep directory trees, this limit may need to be raised:

```bash
sysctl fs.inotify.max_user_watches=65536
```

Document this in the deployment guide.

### Bun's `fs.watch` on Linux

Bun uses inotify on Linux. `{ recursive: true }` is supported by walking the directory tree and adding watches for each subdirectory. New subdirectories created by the container are automatically watched.

## Tasks

- [ ] 1. Add `file_idle_ttl_ms` to pool config schema in `packages/core/src/schemas/workload.ts`
- [ ] 2. Add `fileIdleTtlMs` column to pools table in `packages/db/src/schema.ts`, generate migration
- [ ] 3. Add `fileIdleTtlMs` to `ContainerPoolConfig` in `apps/api/lib/container/pool.ts`
- [ ] 4. Create `IdleReaper` class in `apps/api/lib/container/idle-reaper.ts`
- [ ] 5. Add idle reaper metrics to `apps/api/lib/metrics/pool.ts`
- [ ] 6. Integrate `IdleReaper` into `PoolRegistry` (watch on claim, unwatch on release, restore on startup)
- [ ] 7. Wire up the expiry callback to trigger `syncCoordinator.onRelease()` then `pool.releaseForTenant()`
- [ ] 8. Add recovery logic: restore watches from DB on startup, handle containers idle through restart
- [ ] 9. Unit tests: timer reset on write, expiry triggers release, unwatch on explicit release, recovery
- [ ] 10. Integration test: claim container, write to state dir, verify timer resets, stop writing, verify release
