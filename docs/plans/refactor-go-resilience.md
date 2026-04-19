# Go Operator/API Resilience Refactor

Two surviving items extracted from the now-deleted `refactor-01_04_2026.md` (TS-era) — both still apply to the Go port and have direct file/line evidence in the current codebase.

---

## R1. `releaseClaim` loses overlay data on extraction failure

**Files:** `go/internal/operator/claim_controller.go:392-414` (`releaseClaim`), `:454-471` (`handleDeletion`)

### Problem

Both release paths follow the same shape:

```go
if err := r.Snapshots.ExtractAndStore(ctx, pod.Name, tenantId, workloadRef, wl.Spec.Filesystem.OverlayDirs); err != nil {
    ctrl.LoggerFrom(ctx).Error(err, "extracting snapshot on release", ...)
}
// ... falls through to Delete(pod) regardless ...
if err := r.Delete(ctx, pod); err != nil && !apierrors.IsNotFound(err) { ... }
```

A failed extraction (transient kubelet error, pod EOF mid-stream, intermittent network) is logged and ignored. The Pod is then deleted, permanently destroying the tenant's overlay state. Only the previous successful snapshot survives.

This is the same data-loss class as the TS-era `tenant-manager.ts` issue from the original refactor doc, just relocated to controller-runtime code.

### Fix

1. **Retry with backoff** inside `ExtractAndStore` (or wrap the call). Three attempts with exponential backoff (1s, 4s, 16s) covers transient pod/network issues without making release feel hung.

2. **On exhausted retries, do not delete the Pod.** Set `claim.Status.Phase = "ReleaseFailed"` with `claim.Status.Detail` describing the failure, and requeue with a backoff (`reconcile.Result{RequeueAfter: 5 * time.Minute}`). The Pod stays alive so a future reconcile can retry extraction or an operator can intervene.

3. **Add a `ReleaseFailed` phase** to the claim FSM (`api/v1alpha1/claim_types.go`'s status enum). Allowed transitions: `ReleaseFailed → Released` (manual force-destroy) and `ReleaseFailed → Active` (resume).

4. **New API endpoint** `POST /api/v1/tenants/{id}/release/retry` and `POST /api/v1/tenants/{id}/release/force` (drops the snapshot, deletes Pod). Keeps operator workflow explicit.

5. **Apply the same fix to `handleDeletion`** — currently the finalizer path has the same swallow-and-delete pattern (`claim_controller.go:457-460`). On extraction failure, refuse to remove the finalizer and requeue. The Pod and Claim both survive, blocking deletion until the snapshot lands or an operator force-removes.

### Tests

- envtest: simulate `ExtractAndStore` returning an error, assert Claim transitions to `ReleaseFailed`, Pod still exists, Claim is requeued.
- envtest: simulate extraction failing N times then succeeding, assert claim ends up `Released`.
- envtest: deletion path with extraction failure → finalizer remains, deletion blocked, requeue scheduled.

### Scope

`claim_controller.go`, `snapshots.go` (retry helper), `api/v1alpha1/claim_types.go` (new phase), `internal/api/routes_tenant.go` (retry/force endpoints), tests in `claim_controller_test.go`. ~150 lines net, plus tests.

---

## R2. Graceful shutdown of in-flight snapshot extractions

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

R1 and R2 are independent. R1 is higher impact (fixes a routine failure mode); R2 fixes a less frequent but operationally critical case. Do R1 first.

Both depend on no other refactor work.

## Why nothing else from the old plan survives

- **Drizzle migrations / SQLite race / `applyTransition`** — no DB.
- **`bootstrap.ts` god function** — Go uses `ctrl.Manager` + small `cmd/*/main.go` files; no equivalent.
- **`WorkloadWatcher` polling vs `fs.watch`** — replaced by K8s informers via controller-runtime.
- **Pool replenish on manual destroy** — `pool_controller.go` reconciles declaratively; replenishment is a side-effect of comparing desired vs actual count, no event listener needed.
- **Activity log retention** — no `activity_log` table; events are K8s `Event` resources with built-in TTL via `--event-ttl` on kube-apiserver.
- **Node capacity detection / `secretStore!` non-null** — these were TS-API-server concerns; the operator doesn't pick nodes (the scheduler does) and there's no analogous singleton.
- **Single-node assumption comments** — controller-runtime supports leader election; if/when we go multi-replica that's the lever, not in-memory map comments.
- **README clarifying trigger gateway vs API trigger dispatch** — the Go split is unambiguous: the trigger gateway is the only event ingester, and the API only manages CRDs.
