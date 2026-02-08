# Lifecycle Hooks

## Problem

Users need to run custom commands at specific points in a container's lifecycle. Examples:

- Run a migration script when a tenant first claims a container
- Gracefully flush caches or close connections before release
- Initialize application state after sync downloads data
- Run cleanup scripts before the container returns to the pool

Currently, the only way to react to lifecycle events is externally via the activity log. There's no way for a workload author to define commands that run inside the container as part of the claim/release flow.

## Design

Add a `hooks` section to the workload spec. Each hook is a command (string array) executed inside the container via `runtime.exec()` at a specific lifecycle point. Hooks run as part of the orchestrated flow in `claim.ts` and `release.ts` — they're not fire-and-forget.

```yaml
hooks:
  post_claim:
    - command: ["node", "scripts/migrate.js"]
      timeout: 30s
    - command: ["node", "scripts/warm-cache.js"]
      timeout: 10s
  pre_release:
    - command: ["/bin/sh", "-c", "kill -SIGUSR1 1"]  # signal app to flush
      timeout: 5s
```

### Hook Points

Four lifecycle points, matching the natural boundaries in the existing claim/release flow:

| Hook | When | Container State | Use Case |
|------|------|-----------------|----------|
| `post_claim` | After sync + seed + restart + healthy | Running, healthy, data ready | Migrations, cache warming, app-level init |
| `pre_release` | Before sync upload, before pool release | Running, still claimed | Flush state, graceful shutdown signals, cleanup |
| `post_create` | After a new container is created by the pool | Running, idle, no tenant | One-time container setup, install extras |
| `pre_destroy` | Before a container is destroyed | Running or stopped | Cleanup external resources, deregister |

`post_claim` and `pre_release` are the primary hooks — they cover the most common use cases. `post_create` and `pre_destroy` are secondary but useful for container-level setup/teardown that isn't tenant-specific.

> TODO: Lets just have `post_claim` and `pre_release` for now.

### Execution Model

- Hooks run **sequentially** in definition order (a hook may depend on a prior one)
- Each hook has an independent **timeout** (default: `30s`)
- A hook that **fails** (non-zero exit or timeout) is logged as an activity event
- Failure behavior is controlled by `on_error`: `fail` (default) aborts the flow, `continue` logs and proceeds, `retry` retries up to `retries` times
- stdout/stderr are captured and included in activity log events

### Why Not Events/Callbacks?

Hooks are commands that run **inside** the container, not external callbacks. This is intentional:

- Workload authors know their container's tooling — they write hooks in their app's language
- No need to expose APIs or set up webhook endpoints
- `runtime.exec()` already exists and works across backends (Docker today, Kubernetes later)
- Keeps the execution model simple: the orchestrator runs the command and waits

## Workload YAML

```yaml
id: my-workload
name: My Workload
image: myapp:latest

# ... other config ...

hooks:
  post_claim:
    - command: ["python", "scripts/migrate.py"]
      timeout: 30s
      on_error: fail         # abort claim if migration fails

    - command: ["python", "scripts/warm_cache.py"]
      timeout: 60s
      on_error: continue     # non-critical, proceed even if it fails

  pre_release:
    - command: ["/bin/sh", "-c", "kill -USR1 1"]
      timeout: 5s
      on_error: continue

  post_create:
    - command: ["/bin/sh", "-c", "apt-get update && apt-get install -y curl"]
      timeout: 120s
      on_error: fail

  pre_destroy:
    - command: ["python", "scripts/deregister.py"]
      timeout: 10s
      on_error: continue     # best-effort, container is going away anyway
```

All hook points are optional. Within each hook point, multiple commands run in order.

## Lifecycle Integration

### Claim Flow (`claim.ts`)

```
acquire (wipe if new tenant)
  → sync download
  → seed if empty
  → restart
  → wait for healthy
  → **post_claim hooks**        ← NEW
  → start idle reaper watch
```

`post_claim` runs after the container is healthy. This guarantees the application is ready to accept commands — hooks can talk to the running app, hit HTTP endpoints, etc.

If a `post_claim` hook with `on_error: fail` fails, the claim is aborted: the container is released back to the pool (or destroyed if tainted), and the error is propagated to the caller.

### Release Flow (`release.ts`)

```
**pre_release hooks**            ← NEW
  → sync upload
  → release to pool
```

`pre_release` runs while the container is still claimed and running. The app can flush buffers, write final state, etc. Then sync uploads that state.

If a `pre_release` hook fails with `on_error: fail`, the release still proceeds (we can't leave the container in a half-released state), but the error is logged and the release response includes a warning.

### Pool Create (`pool.ts`)

```
create container
  → start
  → wait for healthy
  → **post_create hooks**        ← NEW
  → add to idle pool
```

### Pool Destroy (`pool.ts` / `manager.ts`)

```
**pre_destroy hooks**            ← NEW
  → stop container
  → remove container
```

## Implementation

### Schema (`packages/core/src/schemas/workload.ts`)

New schemas:

```ts
const hookCommandSchema = z.object({
  command: z.array(z.string()).min(1).describe('Command to execute inside the container'),
  timeout: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .optional()
    .default('30s')
    .describe('Maximum time for the command to complete'),
  on_error: z
    .enum(['fail', 'continue', 'retry'])
    .optional()
    .default('fail')
    .describe('Behavior on non-zero exit or timeout'),
  retries: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(1)
    .describe('Number of attempts (only used when on_error is retry)'),
})

const hooksSchema = z.object({
  post_claim: z.array(hookCommandSchema).optional()
    .describe('Commands to run after container is claimed, synced, seeded, restarted, and healthy'),
  pre_release: z.array(hookCommandSchema).optional()
    .describe('Commands to run before sync upload and pool release'),
  post_create: z.array(hookCommandSchema).optional()
    .describe('Commands to run after a new container is created and healthy'),
  pre_destroy: z.array(hookCommandSchema).optional()
    .describe('Commands to run before a container is destroyed'),
})
```

Add to `workloadSpecSchema`:

```ts
hooks: hooksSchema.optional().describe('Lifecycle hook commands'),
```

### Hook Executor (`apps/api/lib/container/hooks.ts`)

New module — single responsibility: run hook commands in a container.

```ts
interface HookExecResult {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

interface HookRunResult {
  hookPoint: string
  results: HookExecResult[]
  aborted: boolean          // true if a 'fail' hook caused early abort
  abortedAt?: number        // index of the hook that caused abort
}

async function runHooks(
  hookPoint: string,
  hooks: HookCommand[] | undefined,
  containerId: ContainerId,
  runtime: ContainerRuntime,
  activityLog: ActivityLog,
): Promise<HookRunResult>
```

Behavior:
1. If `hooks` is undefined or empty, return immediately (no-op)
2. For each hook in order:
   a. Log `hook.started` activity event
   b. Call `runtime.exec(containerId, hook.command)` with a timeout wrapper (`AbortSignal.timeout(hook.timeout)`)
   c. If success (exit 0): log `hook.completed`, continue
   d. If failure (non-zero exit or timeout):
      - `on_error: continue` → log `hook.failed`, continue to next hook
      - `on_error: retry` → retry up to `hook.retries` times, then treat as `fail` or `continue` based on final attempt
      - `on_error: fail` → log `hook.failed`, abort remaining hooks, return with `aborted: true`

### Claim (`apps/api/lib/container/claim.ts`)

After `waitForHealthy`, before idle reaper:

```ts
// Run post_claim hooks
if (workload.hooks?.postClaim) {
  const hookResult = await runHooks(
    'post_claim', workload.hooks.postClaim,
    container.containerId, containerManager.getRuntime(), activityLog,
  )
  if (hookResult.aborted) {
    // Release container back to pool (best-effort), propagate error
    await pool.releaseForTenant(tenantId)
    throw new HookError('post_claim', hookResult)
  }
}
```

### Release (`apps/api/lib/container/release.ts`)

Before sync, after getting the container:

```ts
// Run pre_release hooks
if (workload.hooks?.preRelease) {
  const hookResult = await runHooks(
    'pre_release', workload.hooks.preRelease,
    container.containerId, containerManager.getRuntime(), activityLog,
  )
  if (hookResult.aborted) {
    // Log warning but continue release — can't leave container half-released
    logHookWarning('pre_release', hookResult, activityLog)
  }
}
```

### Pool (`apps/api/lib/container/pool.ts`)

After creating a container in `createIdleContainer` / background fill:

```ts
// Run post_create hooks on new container
if (workload.hooks?.postCreate) {
  await runHooks('post_create', workload.hooks.postCreate, runtimeId, runtime, activityLog)
}
```

Before destroying in `destroyContainer`:

```ts
// Run pre_destroy hooks
if (workload.hooks?.preDestroy) {
  await runHooks('pre_destroy', workload.hooks.preDestroy, runtimeId, runtime, activityLog)
}
```

### Activity Events

New event types:

```ts
| 'hook.started'
| 'hook.completed'
| 'hook.failed'
```

Event payload includes: hook point, command, exit code, stdout/stderr (truncated), duration, error message.

### Types (`packages/core/src/types.ts`)

The raw/camelCase type derivation already works — `WorkloadSpecRaw` infers from the Zod schema and `WorkloadSpec` applies `CamelCasedPropertiesDeep`. The new `hooks` field with `post_claim` → `postClaim` etc. happens automatically.

No manual type definitions needed.

## Example: OpenClaw Workload

```yaml
id: openclaw
name: OpenClaw Agent
image: ghcr.io/openclaw/openclaw:latest

# ... existing config ...

hooks:
  post_claim:
    # Ensure workspace structure is up to date after sync/seed
    - command: ["node", "dist/index.js", "init", "--skip-existing"]
      timeout: 15s
      on_error: continue

  pre_release:
    # Tell the gateway to flush pending writes
    - command: ["curl", "-sf", "-X", "POST", "http://localhost:18789/__openclaw__/flush"]
      timeout: 10s
      on_error: continue
```

## Edge Cases

- **No hooks configured**: Zero overhead. All hook checks are `if (workload.hooks?.postClaim)` — short-circuit on undefined.
- **Hook timeout**: `AbortSignal.timeout()` kills the exec. Treated as failure.
- **Container dies during hook**: `runtime.exec()` will throw. Treated as hook failure.
- **Hook writes to state dir**: Works fine — hooks run as the container user. State is synced on release as normal.
- **post_claim abort**: Container is released back to pool. Caller gets an error. They can retry claim (may get same or different container).
- **pre_release abort**: Release proceeds anyway. Error is logged. Sync still runs (best-effort to persist state).
- **post_create abort**: Container is destroyed and re-created by the pool fill loop.
- **Hooks + no runtime.exec**: If a future runtime doesn't support exec, `runHooks` checks for the capability and skips with a warning.

## Tests

### Unit tests (`apps/api/lib/container/hooks.test.ts`)

Uses mock runtime. No Docker required.

**runHooks basics:**
- Empty hooks array → no-op, not aborted
- Single successful hook → completed, not aborted
- Single failing hook with `on_error: fail` → aborted
- Single failing hook with `on_error: continue` → not aborted
- Multiple hooks run in order, stdout/stderr captured
- Timeout → treated as failure
- `on_error: retry` retries correct number of times

**Claim flow with hooks:**
- Hooks run after healthy, before idle reaper watch
- Failing `post_claim` hook with `on_error: fail` → container released, error thrown
- Failing `post_claim` hook with `on_error: continue` → claim succeeds

**Release flow with hooks:**
- Hooks run before sync upload
- Failing `pre_release` hook → release still completes, warning logged

### E2E tests

- Claim with `post_claim` hook that creates a marker file → verify file exists after claim
- Release with `pre_release` hook that writes timestamp → verify in sync output
- Hook timeout → claim fails with descriptive error
- Hook ordering → second hook sees side effects of first
