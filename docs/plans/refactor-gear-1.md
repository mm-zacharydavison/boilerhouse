# Refactor Gear 1: Architecture Improvements

Status: **Draft**

---

## What's Working Well

- **Clear domain modeling.** DB is source of truth for domain state, Docker for container existence. Recovery module reconciles on startup.
- **Wipe-on-entry.** Deferring wipe from release to acquire + `lastTenantId` affinity gives returning tenants zero-cost reclaims while guaranteeing isolation.
- **`App` composition root.** Constructor-injected dependencies, no service locator, testable by design. Test harness creates real `App` instances with mock runtimes.
- **Runtime abstraction.** `ContainerRuntime` is a clean interface at the right level.
- **Workload-as-YAML with Zod validation.** snake_case YAML / camelCase TypeScript boundary handled systematically with `CamelCasedPropertiesDeep` and centralized conversion.

---

## Issues & Plan

### 1. Branded types aren't actually branded

> TODO: Good, lets implement this.

**Files:** `packages/core/src/types.ts:36-69`

All "branded" IDs are just `string`. The compiler won't catch `pool.acquireForTenant(poolId)` where you meant `tenantId`. We're paying the ergonomic cost (`as TenantId` casts) without getting safety.

**Plan:** Use real branded types:
```typescript
type Brand<T, B extends string> = T & { readonly __brand: B }
export type TenantId = Brand<string, 'TenantId'>
export type ContainerId = Brand<string, 'ContainerId'>
// etc.
```
Or drop the aliases and just use `string` if branding isn't worth it.

---

### 2. Extract claim orchestration from route handler

> TODO: Good, lets do it.

**Files:** `apps/api/src/routes/tenants.ts:134-208`

The `POST /:id/claim` handler is a 70-line orchestration sequence: acquire, sync, restart, watch. It has sync error handling logic duplicated from `release.ts`. This is a controller acting as a service.

**Plan:** Extract `claimContainer(tenantId, pool, deps)` in `lib/container/claim.ts`, parallel to `releaseContainer`. Route handler becomes: validate input, call service, map to HTTP response. This also makes the claim flow unit-testable without HTTP.

---

### 3. `ContainerPool` constructor has side effects

> TODO: Good, let's do it.

**Files:** `apps/api/lib/container/pool.ts:111-113`

Constructor calls `loadFromDb()` and `startFillLoop()`, starting a `setInterval` and running synchronous DB queries. This makes the class hard to test in isolation and impossible to construct without a live DB.

**Plan:** Remove side effects from constructor. Add an explicit `start()` method. Update `PoolRegistry.restoreFromDb` and `createPool` to call `pool.start()` after construction.

---

### 4. Synchronous filesystem walking in the poll loop

> TODO: Can we parallelize it?

**Files:** `apps/api/lib/container/idle-reaper.ts:301-325`

`walkMtimes` uses `readdirSync`/`statSync` recursively in a `setInterval` callback. With many watched containers or deep state directories, this blocks the event loop.

**Plan:** Yes, parallelize across containers. Three changes:

> TODO: New question: is there an existing package or utility we can use to quickly check if a directory or directory tree has any changes?
>       Do we need to check every file, or could we just check root directories?

**Re: directory mtime shortcut** — No, checking only root directory mtime won't work. On Linux/macOS, a directory's mtime only updates when direct children are added or removed. Modifying the *contents* of an existing file does NOT update its parent directory's mtime. So checking root dirs would miss most file writes.

**Re: packages** — chokidar doesn't work reliably with Bun. `@parcel/watcher` has a nice `getEventsSince()` API but its native module doesn't build under Bun. `fs.watch` (recursive) works on Bun/macOS but has inotify limits on Linux (8192 default) and event coalescing issues under heavy I/O. Given that we already have polling and need mtime for restart recovery anyway, staying with polling is the right call.

~~**Optimization: shallow heuristic + periodic deep walk.**~~ Ruled out — shallow checks miss file content modifications (only catches add/remove), which makes idle TTL unreliable. File counts are small enough for now; a fit-for-purpose tool can be built later if needed.

**Plan:** Keep the full walk, but fix the concurrency/blocking issues:

1. **Async walk per container.** Replace `readdirSync`/`statSync` with `readdir`/`stat` from `fs/promises`. Add a file-count cap (bail after 10k entries).

2. **Parallel walks across containers.** Change `poll()` to `Promise.allSettled` so all watched containers are checked concurrently:
   ```typescript
   private async poll(): Promise<void> {
     const entries = [...this.watches.entries()]
     await Promise.allSettled(
       entries.map(([id, entry]) => this.pollOne(id, entry))
     )
   }
   ```

3. **Async-safe scheduling.** Replace `setInterval` with self-scheduling `setTimeout` so a slow poll doesn't stack:
   ```typescript
   private schedulePoll(): void {
     this.pollTimer = setTimeout(async () => {
       await this.poll()
       this.schedulePoll()
     }, this.pollIntervalMs)
   }
   ```

---

### 5. No error domain / custom error types

> TODO: Good, I like custom errors like this, do it.

Errors are thrown as plain `Error` with string messages. Route handlers catch-all with `set.status = 500`. No distinction between pool-at-capacity (429), container-not-found (404), or internal failures (500).

**Plan:** Define error classes in `lib/errors.ts`:
```typescript
export class PoolCapacityError extends Error { status = 429 }
export class ContainerNotFoundError extends Error { status = 404 }
export class WorkloadNotFoundError extends Error { status = 404 }
```
Add an Elysia error handler that maps `error.status` to HTTP responses. Route handlers stop catching errors manually.

---

### 6. Eliminate in-memory idle queue — DB is the only source of truth

> TODO: I'd like to explore this a bit more. This difference of database vs in-memory representation is a constant issue and I'd love to solve it in a more robust, repeatable way. Consider other solutions. Do we even need the in-memory convenience? could we just use the DB?

**Files:** `apps/api/lib/container/pool.ts:87-88`

The `idleQueue` array shadows DB `status='idle'` rows. If any code path modifies the DB directly (recovery, bugs), the queue diverges. `releaseForTenant` pushes to `idleQueue` without dedup checks. No periodic reconciliation.

**Analysis:** We don't need the in-memory queue at all. The `containers` table already has a composite index on `(poolId, status)`, which makes `WHERE pool_id = ? AND status = 'idle' LIMIT 1` an index-only scan — ~10-50 microseconds on a 50-row table. Compare to Docker health checks at 10-100ms. The queue overhead is invisible.

The current `idleQueue` is actually *worse* than DB queries in some cases: `Array.shift()` is O(n) and `indexOf + splice` for removal is O(n). Indexed DB lookups are O(log n) and constant regardless of pool size.

**Plan:** Delete `idleQueue` entirely. Every operation becomes a DB query:

> TODO: Can we also make this change for other places that have "in memory" and "db" copies of data? We'd like to just use DB as source of truth and not have parallel representations.

| Current (in-memory) | Replacement (DB query) |
|---|---|
| `idleQueue.shift()` in acquire | `SELECT ... WHERE poolId = ? AND status = 'idle' LIMIT 1` |
| `idleQueue.push()` in release | No-op. `UPDATE status = 'idle'` is sufficient. |
| `idleQueue.push()` in createAndInsert | No-op. `INSERT ... status = 'idle'` is sufficient. |
| `removeFromIdleQueue()` | Delete entirely. |
| `loadFromDb()` in constructor | Delete entirely. |
| `idleQueue.length > 0` in scaleTo | `SELECT ... WHERE status = 'idle' LIMIT 1` |

This removes ~50 lines of queue management code and eliminates the entire class of sync bugs. The `loadFromDb()` call in the constructor also goes away, which helps with #3 (constructor side effects).

This change is a prerequisite for #9 (concurrency safety) since atomic DB operations replace racy queue-then-DB sequences.

**Re: other in-memory/DB duplications.** Audited the full codebase. Good news: `idleQueue` is the only true duplication. Everything else is either legitimately runtime-only or already DB-first:

| Component | In-Memory State | Verdict |
|---|---|---|
| `ContainerPool.idleQueue` | `ContainerId[]` | **ELIMINATE** (this item) |
| `IdleReaper.watches` | `Map<ContainerId, WatchedContainer>` | **KEEP** — runtime timers + mtime tracking. `idleExpiresAt` already persisted. `lastModified` could be persisted to a new `last_mtime` column to improve restart accuracy, but not required. |
| `SyncCoordinator.periodicJobs` | `Map<TenantId, PeriodicSyncJob>` | **KEEP** — active `setTimeout` handles. Ephemeral by nature. `lastSyncAt` could read from `syncStatus` table instead of in-memory. |
| `PoolRegistry.pools` | `Map<PoolId, ContainerPool>` | **KEEP** — runtime objects with fill loops, not a data cache. Config comes from DB on `restoreFromDb()`. |
| `SyncStatusTracker` | No in-memory state | **EXEMPLARY** — pure DB wrapper. This is the pattern to follow. |
| `WorkloadRegistry.workloads` | `Map<WorkloadId, WorkloadSpec>` | **KEEP** — file-backed (YAML), not DB-backed. `fs.watch` keeps it in sync. |
| `ActivityLog.listeners` | `Set<ActivityEventListener>` | **KEEP** — pub/sub callbacks, not data. |

Bottom line: after eliminating `idleQueue`, the only remaining in-memory state is either active timers or runtime objects — things that genuinely can't live in a DB.

---

### 7. `PoolRegistry` lookup methods are O(pools * queries)

> TODO: Good, lets do it. In fact, I'd like to replace as much in-memory stuff with DB lookups as possible.

**Files:** `apps/api/lib/pool/registry.ts:391-413, 463-470`

`getPoolForTenant` iterates every pool calling `hasTenant` (each a DB query). `getContainerInfo` loads all containers per pool then does a linear search.

**Plan:** Replace with direct DB queries:
- `getPoolForTenant`: `SELECT poolId FROM containers WHERE tenantId = ? AND status = 'claimed' LIMIT 1`
- `getContainerInfo`: `SELECT * FROM containers WHERE containerId = ? LIMIT 1`

Both are single indexed lookups.

---

### 8. Duplicated sync result handling

> TODO: Good, lets do it (although i dont like utils.ts files, so a better name would be good)

The pattern of reducing sync results, checking errors, and logging appears in three places: `tenants.ts:163-169`, `tenants.ts:278-286`, `release.ts:46-53`.

**Plan:** Extract `logSyncResults(tenantId, results, activityLog)` into `lib/sync/logging.ts`. The function reduces results, checks for errors, and calls the appropriate activity log methods. All three call sites become one-liners.

---

### 9. No concurrency safety on concurrent claims

> TODO: If we use the database as the authorative source of truth, could we use transactions and make this safe?

**Files:** `apps/api/lib/container/pool.ts:144-314`

`acquireForTenant` has no locking. Two concurrent claims for the same tenant can both see no `existingClaim`, pop different idle containers, and create two claimed rows for one tenant.

**Plan:** Yes — with #6 (DB-only, no idle queue) this becomes straightforward. Use **optimistic locking via conditional UPDATE**:

```typescript
// Atomic claim: only succeeds if container is still idle
const claimed = db.update(containers)
  .set({ status: 'claimed', tenantId, claimedAt: now })
  .where(and(
    eq(containers.containerId, candidate.containerId),
    eq(containers.status, 'idle')  // guard: fails if already claimed
  ))
  .returning()
  .get()

if (!claimed) {
  // Someone else claimed it between our SELECT and UPDATE — retry next candidate
  continue
}
```

The `WHERE status = 'idle'` guard makes the UPDATE a no-op if another request claimed it first. No mutex needed, no `BEGIN IMMEDIATE` transaction needed — SQLite serializes writes automatically and the conditional WHERE is sufficient.

For the existing-claim check at the top of acquire, wrap it in a similar pattern: `SELECT ... WHERE tenantId = ? AND status = 'claimed'` — if this returns a row, return it. Two concurrent requests will both see the same existing claim and return the same container. No race.

Depends on: #6 (eliminating the idle queue so there's no in-memory state to race on).

---

### 10. Replace `console.log` with structured logging

> TODO: Yes, lets do it. Use the elysia logger plugin.

No structured logging anywhere. String interpolation with `[Pool]`, `[Sync]`, `[IdleReaper]` prefixes throughout.

**Plan:** Use `@bogeychan/elysia-logger` — a pino-based Elysia plugin (no official `@elysiajs/logger` exists). Compatible with Elysia 1.2.x.

```bash
bun add @bogeychan/elysia-logger
```

1. **HTTP layer:** Add to server.ts. Gives `ctx.log` in all route handlers with automatic request/response logging.
   ```typescript
   import { logger } from '@bogeychan/elysia-logger'
   app.use(logger({ level: 'info' }))
   ```

2. **Service layer:** Use `createPinoLogger()` from the same package to create a shared logger instance. Pass it through `App` constructor to services (`ContainerPool`, `SyncCoordinator`, `IdleReaper`, etc.) replacing `console.log`.
   ```typescript
   const log = createPinoLogger({ level: 'info' })
   // In services:
   this.log.info({ containerId, tenantId, poolId }, 'Container claimed')
   ```

3. **Dev vs prod:** Use `pino-pretty` transport in dev for readable output, raw JSON in prod for log aggregation.

---

### 11. Dashboard types are disconnected from API types

> TODO: Yes, sounds good.

**Files:** `apps/dashboard/src/api/types.ts`

Dashboard defines its own `PoolInfo`, `ContainerInfo`, `TenantInfo` that must be manually kept in sync with API route return shapes. API routes return ad-hoc object literals.

**Plan:** Move shared response types (`PoolInfo`, `ContainerInfo`, `TenantInfo`, etc.) into `@boilerhouse/core`. Have both the API routes and dashboard import from the same source. The types already exist in `lib/pool/registry.ts` — promote them to the core package.

---

### 12. No request-scoped context / tracing

> TODO: Can we do this automatically with some OTEL elysia plugin or similar? Or using an Asynclocalstorage based solution? I dont want to manually pass correlation ids everywhere.

When a claim involves acquire + sync + restart + watch, there's no correlation ID tying log lines together. Concurrent claims interleave in logs.

**Plan:** Use `AsyncLocalStorage` — no manual passing. Two options, can be combined:

**Option A: Lightweight — AsyncLocalStorage + pino child logger.**
Set up in Elysia `onRequest` hook:
```typescript
import { AsyncLocalStorage } from 'node:async_hooks'
const requestContext = new AsyncLocalStorage<{ requestId: string; log: Logger }>()

app.onRequest(({ request }) => {
  const requestId = request.headers.get('x-request-id') || crypto.randomUUID()
  const log = rootLogger.child({ requestId })
  requestContext.enterWith({ requestId, log })
})
```
Services call `requestContext.getStore()?.log.info(...)` — the request ID is automatically included in every log line without passing it as a parameter. This pairs with #10 (pino logger).

**Option B: Full OTEL — `@elysiajs/opentelemetry`.**
An official Elysia plugin (compatible with 1.2.x). Automatically creates spans with trace IDs for every request and provides `getCurrentSpan()` via AsyncLocalStorage. Integrates with the existing Prometheus/Grafana stack.
```bash
bun add @elysiajs/opentelemetry
```
Services access the trace context anywhere without parameter passing:
```typescript
import { getCurrentSpan } from '@elysiajs/opentelemetry'
import * as api from '@opentelemetry/api'

function anyServiceMethod() {
  const span = api.trace.getSpan(api.context.active())
  const traceId = span?.spanContext().traceId
  // traceId is automatically available — no parameter passing
}
```

**Plan:** Use Option B. It gives automatic trace IDs, integrates with the existing Prometheus/Grafana observability stack, and pairs with #10 (pino) by including `traceId` in log output:
```typescript
// In pino logger setup, include OTEL trace context
const log = createPinoLogger({
  mixin() {
    const span = api.trace.getSpan(api.context.active())
    return { traceId: span?.spanContext().traceId }
  }
})
```
This means every log line from every service automatically gets a `traceId` field — no manual passing, no `AsyncLocalStorage` setup beyond what OTEL provides out of the box.

---

## Execution Order

Items #6, #9, and #3 form a dependency chain and should be done together as a single body of work. #10 and #12 pair naturally.

| Phase | Issues | Description | Effort |
|-------|--------|-------------|--------|
| **1** | #6, #9, #3 | **DB-only pool.** Eliminate idle queue, add optimistic locking on acquire, remove constructor side effects. One connected change. | Medium |
| **2** | #4 | **Async parallel idle reaper.** Unblocks event loop. Independent of phase 1. | Medium |
| **3** | #5, #2, #8 | **Clean up service layer.** Error types, extract claim service, deduplicate sync logging. All low-effort, high-value. | Low |
| **4** | #10, #12 | **Observability.** Structured logging (pino) + OTEL (`@elysiajs/opentelemetry`). Pino `mixin` pulls trace IDs from OTEL context automatically. | Medium |
| **5** | #7, #11 | **DB-first lookups + shared types.** Replace in-memory registry scans with direct DB queries. Promote API response types to `@boilerhouse/core`. | Medium |
| **6** | #1 | **Branded types.** Mechanical refactor, do last since it touches many files. | Low |
