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

### New Config: `fileIdleTtl`

Add an optional `file_idle_ttl` field to the pool configuration in the workload YAML:

```yaml
pool:
  min_size: 2
  max_size: 20
  file_idle_ttl: "5m"  # 5 minutes of filesystem inactivity triggers release
```

Follows the existing duration field convention (same as `idle_timeout`) — accepts both numbers (ms) and duration strings (`"5m"`, `"300s"`, etc.). After schema parsing via `durationString.transform(parseDuration)`, the value is always a number in milliseconds. Through the `CamelCasedPropertiesDeep` pipeline (`PoolConfigRaw` → `PoolConfig`), it becomes `fileIdleTtl` in TypeScript code.

When set, boilerhouse watches the state directory of each claimed container and releases it if no writes occur within the TTL window. When unset (default), the existing behaviour is preserved — containers are only released via explicit API calls or the existing `idleTimeoutMs` eviction.

### `IdleReaper` Component

A new `IdleReaper` class that monitors claimed containers for filesystem inactivity.

```
┌─────────────────────────────────────────────────────┐
│ IdleReaper                                          │
│                                                     │
│   For each claimed container with fileIdleTtl       │
│   configured:                                       │
│                                                     │
│   1. fs.watch(stateDir) via inotify                 │
│   2. On write event → reset idle timer              │
│   3. On timer expiry → trigger release              │
│                                                     │
│   Called from route handler (tenants.ts):            │
│   - POST /:id/claim  (after sync+restart) → watch   │
│   - POST /:id/release (before sync)      → unwatch  │
│                                                     │
│   On expiry:                                        │
│   - syncCoordinator.onRelease() → final sync        │
│   - pool.releaseForTenant() → return to pool        │
│                                                     │
└─────────────────────────────────────────────────────┘
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

The claim/release flow (including sync coordination) currently lives in the **route handler** (`apps/api/src/routes/tenants.ts`), not in `PoolRegistry`. The IdleReaper hooks into this same layer.

#### On Claim (route handler: `POST /:id/claim`)

After the full claim flow completes (acquire → wipe → sync download → restart):

1. Check if pool has `fileIdleTtl` configured (via `pool.getConfig().fileIdleTtl`)
2. If so, call `idleReaper.watch(containerId, tenantId, poolId, stateDir, fileIdleTtl)`
3. The reaper starts an `fs.watch` on the state directory and sets an initial idle timer

The watch starts *after* the container restart, so sync-engine writes and wipe operations don't reset the timer.

#### On Write Detected

When inotify fires for any file change in the state directory:

1. Clear the existing idle timer
2. Reset a new timer for `fileIdleTtl` from now
3. Update `lastActivity` in the `containers` table (debounced — at most once per second to avoid DB thrash)

#### On Timer Expiry

When the idle timer fires (no writes for `fileIdleTtl`):

1. Log the expiry event
2. Trigger the same release flow as the API route: `syncCoordinator.onRelease()` then `pool.releaseForTenant()`
3. The reaper cleans up its own watcher as part of the release

The `onExpiry` callback needs access to `syncCoordinator`, `poolRegistry`, and `containerManager` — these are provided at construction time (same dependencies the route handler has).

#### On Explicit Release (route handler: `POST /:id/release`)

When `releaseForTenant()` is called via the API (before TTL):

1. `idleReaper.unwatch(containerId)` — closes the fs.watch and clears the timer
2. Normal release flow proceeds (sync → release)

### Metrics

| Metric                                    | Type    | Labels           | Description                                   |
| ----------------------------------------- | ------- | ---------------- | --------------------------------------------- |
| `boilerhouse_idle_reaper_watches_active`  | Gauge   | `pool_id`        | Number of containers currently being watched   |
| `boilerhouse_idle_reaper_expirations`     | Counter | `pool_id`        | Containers released due to filesystem idle TTL |
| `boilerhouse_idle_reaper_resets`          | Counter | `pool_id`        | Timer resets from filesystem activity          |

### Recovery

On startup, `IdleReaper` needs to restore watches for containers that were claimed before the restart:

1. After `poolRegistry.restoreFromDb()` completes (pools and containers are loaded), call `idleReaper.restoreFromDb()`
2. Query `containers` table for all `claimed` containers where the owning pool has `fileIdleTtl` set (join with `pools` table)
3. For each such container:
   - `stat()` the state directory to get last mtime
   - If `now - mtime > fileIdleTtl` — release immediately (was idle through the restart)
   - Otherwise — start watching with remaining TTL (`fileIdleTtl - (now - mtime)`)

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

interface IdleReaperDeps {
  db: DrizzleDb
  onExpiry: (containerId: ContainerId, tenantId: TenantId, poolId: PoolId) => Promise<void>
}

class IdleReaper {
  private watches: Map<ContainerId, WatchedContainer>

  constructor(deps: IdleReaperDeps)

  watch(containerId, tenantId, poolId, stateDir, ttlMs): void
  unwatch(containerId): void
  restoreFromDb(pools: Map<PoolId, ContainerPool>, manager: ContainerManager): void
  shutdown(): void
}
```

Key implementation details:
- `watch()` creates an `fs.watch(stateDir, { recursive: true })` and starts the idle timer
- On `'change'` events, debounce the `lastActivity` DB update on the `containers` table (max once per second)
- `onExpiry` callback is provided at construction time — it receives the full release flow (sync + release + logging) as a closure with captured dependencies
- `restoreFromDb()` queries claimed containers in pools with `fileIdleTtl`, checks mtime, and either releases immediately or starts watching with remaining TTL
- `shutdown()` closes all watchers and clears all timers

### Files to Modify

#### `packages/core/src/schemas/workload.ts`

Add `file_idle_ttl` to the pool config schema, using the same duration pattern as `idle_timeout`:

```typescript
// In poolConfigSchema
file_idle_ttl: z
  .union([z.number().int().min(0), durationString.transform(parseDuration)])
  .optional()
  .describe('Filesystem inactivity timeout before auto-releasing a claimed container (e.g., "5m")'),
```

#### `apps/api/lib/container/pool.ts`

- Add optional `fileIdleTtl?: number` to `ContainerPoolConfig` interface (line 38)
- Expose via `getConfig()` or similar so the route handler can check if file idle TTL is enabled

#### `apps/api/lib/pool/registry.ts`

- Pass `fileIdleTtl` through in `createPool()` config parameter and `restoreFromDb()` (from DB record)
- On `shutdown()`, call `idleReaper.shutdown()`

#### `apps/api/src/routes/tenants.ts`

- **On claim** (after sync + restart): call `idleReaper.watch()` if pool has `fileIdleTtl`
- **On release** (before sync): call `idleReaper.unwatch(containerId)`
- The IdleReaper instance is passed as a dependency alongside `poolRegistry`, `syncCoordinator`, etc.

#### `packages/db/src/schema.ts`

Add `fileIdleTtl` to the pools table:

```typescript
fileIdleTtl: integer('file_idle_ttl'),
```

#### `apps/api/lib/metrics/pool.ts`

Add the three new metrics for the idle reaper.

### DB Migration

One new nullable column on the `pools` table:

```sql
ALTER TABLE pools ADD COLUMN file_idle_ttl INTEGER;
```

## Edge Cases

### Container writes during sync download (onClaim)

The idle reaper should only be started *after* the full claim flow completes (acquire → wipe → sync download → restart). This avoids counting sync-engine writes and wipe operations as tenant activity.

Sequence in route handler: `pool.acquireForTenant()` → `manager.wipeForNewTenant()` → `syncCoordinator.onClaim()` → `manager.restartContainer()` → `idleReaper.watch()`

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

- [ ] 1. Add `file_idle_ttl` to pool config schema in `packages/core/src/schemas/workload.ts` (duration string support)
- [ ] 2. Add `fileIdleTtl` column to `pools` table in `packages/db/src/schema.ts`, generate migration
- [ ] 3. Add optional `fileIdleTtl` to `ContainerPoolConfig` in `apps/api/lib/container/pool.ts`
- [ ] 4. Thread `fileIdleTtl` through `PoolRegistry.createPool()` and `restoreFromDb()` (config param + DB persist/restore)
- [ ] 5. Create `IdleReaper` class in `apps/api/lib/container/idle-reaper.ts`
- [ ] 6. Add idle reaper metrics to `apps/api/lib/metrics/pool.ts` (Gauge + 2 Counters)
- [ ] 7. Integrate `IdleReaper` into route handler (`tenants.ts`): watch after claim, unwatch before release
- [ ] 8. Wire up the expiry callback with access to `syncCoordinator`, `poolRegistry`, `containerManager`
- [ ] 9. Add recovery logic: `idleReaper.restoreFromDb()` after pool restore, handle containers idle through restart
- [ ] 10. Unit tests: timer reset on write, expiry triggers release, unwatch on explicit release, recovery
- [ ] 11. Integration test: claim container, write to state dir, verify timer resets, stop writing, verify release
