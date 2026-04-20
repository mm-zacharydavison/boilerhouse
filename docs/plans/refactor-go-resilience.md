# Go Operator/API Resilience Refactor

Two items extracted from the deleted `refactor-01_04_2026.md` (TS-era). R1 is partially shipped; R2 is outstanding.

---

## R1. `releaseClaim` loses overlay data on extraction failure

**Status: shipped** (controller behavior + envtest coverage). Operator-facing remediation endpoints deferred — see "Outstanding" below.

### Problem (resolved)

Both release paths logged the extraction failure and fell through to `r.Delete(pod)`, permanently destroying overlay state. Same data-loss class as the TS-era `tenant-manager.ts` issue.

### Shipped fix

- `Snapshotter` interface introduced in `go/internal/operator/snapshots.go`. `ClaimReconciler.Snapshots` is now the interface; `*SnapshotManager` is the production implementation. Enabled unit-level testing of the failure paths without `kubectl`.
- `ReleaseFailed` added to the claim phase enum (`go/api/v1alpha1/claim_types.go` + `config/crd/bases-go/boilerhouse.dev_boilerhouseclaims.yaml`).
- `extractWithRetry` helper on `ClaimReconciler` retries `Snapshots.ExtractAndStore` per the configurable `ExtractRetryBackoff` schedule (default `[1s, 4s, 16s]`, ctx-aware sleeps). Tests inject zeros.
- `releaseClaim` calls `markReleaseFailed` on exhausted retries — sets `phase=ReleaseFailed` with the error in `Detail`, requeues `5m`, leaves the Pod alive.
- `handleDeletion` (finalizer path) refuses to remove the finalizer or delete the Pod on extract failure; requeues `5m`. Claim and Pod both survive.
- `Reconcile` switch routes `ReleaseFailed` to a no-op so the held Pod isn't re-entered as a new claim.

Three envtest tests in `go/internal/operator/claim_resilience_test.go`:
- `TestClaimController_IdleReleaseExtractionFailureKeepsPod` — bug repro on idle path; asserts Pod retained, phase=`ReleaseFailed`, retried 3 times.
- `TestClaimController_IdleReleaseExtractionRetrySucceeds` — proves retry actually retries (succeeds on 3rd attempt → `Released`).
- `TestClaimController_DeletionExtractionFailureBlocksFinalizer` — bug repro on finalizer path; asserts Claim and Pod both retained, finalizer not removed.

### Outstanding (R1 follow-ups)

- **Operator-facing remediation endpoints.** Currently a `ReleaseFailed` claim sits with a held Pod indefinitely (background requeue every 5 minutes will keep retrying, but there's no explicit operator workflow). Add:
  - `POST /api/v1/tenants/{id}/release/retry` — re-enter `releaseClaim` immediately, returns the new phase.
  - `POST /api/v1/tenants/{id}/release/force` — delete the snapshot, delete the Pod, transition the claim to `Released` regardless of extract state. Operator-only escape hatch.
  Files: `go/internal/api/routes_tenant.go` (mount), new handlers, tests via httptest+envtest.
- **Background retry behavior under sustained failure.** The 5-minute requeue keeps trying with backoff `[1s, 4s, 16s]` per attempt. If the underlying issue is permanent (snapshot PVC full, helper Pod gone), this is wasted churn. Consider an attempt-count annotation on the Claim and a backoff cap, or fall back to "alert and stop retrying after N failures". Defer until the endpoints exist and we observe operator behavior.
- **e2e coverage on minikube.** Inject a real failure (e.g. shut down the snapshot helper Pod mid-release) via `tests/e2e-operator` and verify the new behavior end-to-end. Envtest can't reach kubectl/exec, so the in-process tests use a fake `Snapshotter`.
- **`destroy` action with extract+delete.** When `idle.action=destroy`, the controller currently `DeleteSnapshot` (best-effort) then deletes the Pod. There's no overlay-loss concern (the operator explicitly asked to destroy), so no fix needed — just noting that `destroy` deliberately bypasses `extractWithRetry`.

---

## R2. Graceful shutdown of in-flight snapshot extractions

**Status: not started.**


**Files:** `go/cmd/operator/main.go`, `go/internal/operator/snapshots.go`, `go/internal/trigger/gateway.go`

### Problem

`ctrl.Manager.Start(ctx)` propagates context cancellation to every reconciler when the operator receives SIGTERM. That includes the Snapshot.ExtractAndStore call invoked from `releaseClaim` and `handleDeletion`. If a release happens to be running when the pod is told to terminate (rolling update, node drain, kubectl delete), the extraction is cancelled mid-stream — same data-loss outcome as R1.

The trigger gateway has the symmetric problem: `Sync(ctx)` cancels in-flight `driver.Send` and any open Telegram poll, leaving an in-progress claim ensure half-done.

K8s gives the pod a `terminationGracePeriodSeconds` window (default 30s). We must finish, fail safely, or refuse new work within that window.

### Fix

1. **Decouple the snapshot extraction context from the reconcile context.** In `Snapshots.ExtractAndStore`, derive a child context with a hard deadline (e.g. `context.WithTimeout(context.Background(), 90*time.Second)`) rather than inheriting the controller-runtime context. SIGTERM no longer kills mid-flight extractions; they finish on their own deadline. The reconciler's outer context is still respected for the *decision* to extract — once kicked off, the extraction runs to completion.

2. **Bump the operator Pod's `terminationGracePeriodSeconds` to 120s** in `config/deploy/operator-deployment.yaml` so the kubelet allows the in-flight extractions and goroutines to complete.

3. **Drain on shutdown.** Add a shutdown handler that (a) stops accepting new reconciles for `BoilerhouseClaim` (controller-runtime supports this via Manager's `RunnableGroup`), (b) waits for the in-flight `inFlightExtractions` counter to reach 0 or the grace period to elapse, (c) returns. Track in-flight counts via `sync.WaitGroup` inside `SnapshotManager`.

4. **Trigger gateway shutdown.** `gateway.Sync` already calls `g.stopAll()` on `ctx.Done()` (line 68), but `stopAll` immediately cancels each adapter's context. Telegram's `pollLoop` is fine (it just exits the long-poll). The risk is a handler in mid-flight when cancel fires: `ensureClaim` is interrupted, leaving an orphan `BoilerhouseClaim` in `Pending`. Fix: track in-flight handlers with a WaitGroup and have `stopAll` block on it (with a deadline) before returning.

5. **API server shutdown.** `cmd/api/main.go` currently relies on `http.ListenAndServe` ending when the process exits. Replace with `http.Server.Shutdown(ctx)` driven by SIGTERM, so chi finishes in-flight requests. WebSocket connections in `websocket.go` need explicit close — send a close frame then drain.

### Tests

- Unit test: `SnapshotManager.ExtractAndStore` with parent context cancelled mid-call still completes (mock pod-exec stream that takes 2s while parent ctx is cancelled at 100ms).
- Unit test: gateway `stopAll` with a stuck handler waits up to deadline.
- Integration test on minikube: kill the operator pod during a release, verify the next pod startup sees the snapshot in storage and the Claim in `Released`.

### Scope

`snapshots.go` (~30 lines for context decoupling + WaitGroup), `cmd/operator/main.go` (shutdown handler), `gateway.go` (handler WaitGroup), `cmd/api/main.go` (server.Shutdown), `config/deploy/operator-deployment.yaml` (grace period bump), tests. ~200 lines net.

---

## Sequencing

R1's controller behavior is shipped. Remaining work, in order of impact:

1. **R1 follow-up: remediation endpoints** (`/release/retry`, `/release/force`). Small, unblocks operator workflow. Self-contained — does not depend on R2.
2. **R2: graceful shutdown.** Same problem class on a different trigger (SIGTERM mid-extraction instead of single failed call). Independent of the endpoints.
3. **R1 follow-up: e2e coverage and backoff cap.** Lowest priority; inform with operator feedback first.

## Why nothing else from the old plan survives

- **Drizzle migrations / SQLite race / `applyTransition`** — no DB.
- **`bootstrap.ts` god function** — Go uses `ctrl.Manager` + small `cmd/*/main.go` files; no equivalent.
- **`WorkloadWatcher` polling vs `fs.watch`** — replaced by K8s informers via controller-runtime.
- **Pool replenish on manual destroy** — `pool_controller.go` reconciles declaratively; replenishment is a side-effect of comparing desired vs actual count, no event listener needed.
- **Activity log retention** — no `activity_log` table; events are K8s `Event` resources with built-in TTL via `--event-ttl` on kube-apiserver.
- **Node capacity detection / `secretStore!` non-null** — these were TS-API-server concerns; the operator doesn't pick nodes (the scheduler does) and there's no analogous singleton.
- **Single-node assumption comments** — controller-runtime supports leader election; if/when we go multi-replica that's the lever, not in-memory map comments.
- **README clarifying trigger gateway vs API trigger dispatch** — the Go split is unambiguous: the trigger gateway is the only event ingester, and the API only manages CRDs.
