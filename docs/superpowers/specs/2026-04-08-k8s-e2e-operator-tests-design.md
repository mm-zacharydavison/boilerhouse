# Kubernetes Operator E2E Tests — Design Spec

## Goal

Rewrite the Kubernetes E2E tests from scratch to target the operator's CRD-based interface instead of the HTTP API. The operator is fundamentally different from the runtime abstraction — declarative CRDs vs imperative API — so the tests live in a separate directory with their own helpers.

## Directory Structure

```
tests/e2e-operator/
  setup.ts                          — preload: starts operator, exposes KubeTestClient globally
  helpers.ts                        — KubeTestClient, CRD helpers, kubectl wrappers
  fixtures.ts                       — CRD manifest builders (httpserver, minimal, openclaw, wsecho, broken)
  instance-lifecycle.e2e.test.ts
  tenant-lifecycle.e2e.test.ts
  destroy.e2e.test.ts
  events.e2e.test.ts
  error-recovery.e2e.test.ts
  http-connectivity.e2e.test.ts
  idle-timeout.e2e.test.ts
  instance-actions.e2e.test.ts
  concurrent-tenants.e2e.test.ts
  multi-tenant-claim.e2e.test.ts
  multi-workload-claim.e2e.test.ts
  overlay-restore.e2e.test.ts
  pause-before-extract.e2e.test.ts
  secret-gateway.e2e.test.ts
  snapshot-lifecycle.e2e.test.ts
  telegram-poll.e2e.test.ts
  workload-update.e2e.test.ts
  data-persistence.e2e.test.ts
```

Existing `tests/e2e/` keeps serving fake+docker runtimes. The kubernetes runtime option is removed from `tests/e2e/` (runtime-matrix, e2e-helpers, fixtures, runtime-detect) since K8s testing now lives here.

## Test Driver: Hybrid Approach

- **TypeScript K8s client** (`@boilerhouse/k8s`) for creating CRDs, reading status, polling phase transitions
- **kubectl** for runtime verification: `kubectl exec`, `kubectl logs`, `kubectl port-forward`, pod phase checks

## helpers.ts — KubeTestClient

Thin wrapper around the `@boilerhouse/k8s` client configured for `boilerhouse-test` minikube context.

### Methods

| Method | Description |
|--------|-------------|
| `applyWorkload(manifest)` | Create/update a BoilerhouseWorkload CR |
| `applyClaim(manifest)` | Create/update a BoilerhouseClaim CR |
| `applyPool(manifest)` | Create/update a BoilerhousePool CR |
| `applyTrigger(manifest)` | Create/update a BoilerhouseTrigger CR |
| `delete(resource, name)` | Delete a CR by resource type and name |
| `deleteAll(names)` | Batch delete for afterAll cleanup |
| `getStatus(resource, name)` | Read `.status` from a CR |
| `waitForPhase(resource, name, phase, timeoutMs?)` | Poll until `.status.phase` matches |
| `waitForDeletion(resource, name, timeoutMs?)` | Poll until CR no longer exists |

### kubectl Wrappers

| Function | Description |
|----------|-------------|
| `kubectlExec(pod, cmd)` | Run a command in a managed pod |
| `kubectlLogs(pod)` | Get logs from a managed pod |
| `kubectlPortForward(pod, localPort, remotePort)` | Start port-forward, return handle with `stop()` |
| `kubectlGetPodPhase(podName)` | Return pod phase (Running, Pending, etc.) |
| `kubectlPodExists(podName)` | Check if pod exists |

### Utilities

| Function | Description |
|----------|-------------|
| `uniqueName(prefix)` | Generate unique CRD name like `test-a1b2-prefix` |
| `getTestClient()` | Retrieve the globally-set KubeTestClient from setup |

## fixtures.ts — CRD Manifest Builders

TypeScript functions that return CRD objects with unique names injected. Not YAML files.

```typescript
export function httpserverWorkload(name: string): BoilerhouseWorkload { ... }
export function minimalWorkload(name: string): BoilerhouseWorkload { ... }
export function openclawWorkload(name: string): BoilerhouseWorkload { ... }
export function wsechoWorkload(name: string): BoilerhouseWorkload { ... }
export function brokenWorkload(name: string): BoilerhouseWorkload { ... }

export function claim(name: string, tenantId: string, workloadRef: string): BoilerhouseClaim { ... }
export function pool(name: string, workloadRef: string, size: number): BoilerhousePool { ... }
export function trigger(name: string, workloadRef: string, config: TriggerConfig): BoilerhouseTrigger { ... }
```

Fixture images: same container images used by the current docker E2E tests. Must be available in minikube's image cache (pulled or built locally).

## setup.ts — Global Test Setup

Preloaded via CLI flag (`--preload ./tests/e2e-operator/setup.ts`).

Steps:
1. Verify minikube context `boilerhouse-test` is reachable
2. Apply CRDs from `apps/operator/crds/` (idempotent)
3. Extract minikube API URL and auth from kubeconfig
4. Spawn operator process: `bun run apps/operator/src/main.ts` with env vars for minikube auth
5. Poll `/healthz` on operator internal API until it responds
6. Create `KubeTestClient`, store globally
7. Register process exit handler to kill operator

No leader election — single operator instance for tests.

Default test timeout: 120s.

## Test Isolation

- All tests use the shared `boilerhouse` namespace
- Each test generates unique CRD names via `uniqueName(prefix)`
- `afterAll` in each test file deletes all CRDs it created
- Tests can run in parallel safely since names don't collide

## Test File Mapping

| Test file | What it tests | Key CRDs |
|-----------|--------------|----------|
| `instance-lifecycle` | Workload → Claim → verify pod → delete Claim → verify cleanup | Workload, Claim |
| `tenant-lifecycle` | Claim status transitions: Pending → Active → Released | Claim |
| `destroy` | Delete Workload with active claims blocks (finalizer). Delete claims first, then workload succeeds | Workload, Claim |
| `events` | Watch CRD status transitions as event mechanism | Workload, Claim |
| `error-recovery` | Broken workload (bad image) → status.phase=Error → fix spec → recovers to Ready | Workload |
| `http-connectivity` | Claim httpserver workload, port-forward, verify HTTP response | Workload, Claim |
| `idle-timeout` | Claim with idle config, wait for operator to set claim phase=Released | Workload, Claim |
| `instance-actions` | `kubectl exec` and `kubectl logs` on managed pod | Workload, Claim |
| `concurrent-tenants` | Multiple Claims for same workload simultaneously, all reach Active | Workload, Claim (x N) |
| `multi-tenant-claim` | Multiple Claims with different tenantIds, same workloadRef | Workload, Claim (x N) |
| `multi-workload-claim` | Multiple Workloads, Claims against each | Workload (x N), Claim (x N) |
| `overlay-restore` | Claim → write data → delete Claim → re-Claim → verify data persists | Workload, Claim |
| `pause-before-extract` | Operator internal API `POST /instances/:id/overlay/extract` before release | Workload, Claim |
| `secret-gateway` | Workload with credentials referencing K8s Secret, verify pod reaches credentialed endpoint | Workload, Claim, Secret |
| `snapshot-lifecycle` | Operator internal API `POST /instances/:id/snapshot`, pool uses snapshot | Workload, Pool, Claim |
| `telegram-poll` | BoilerhouseTrigger with type=telegram, verify phase=Active | Workload, Trigger |
| `workload-update` | Modify Workload CR spec, operator re-reconciles, pool drains/refills | Workload, Pool |
| `data-persistence` | Claim → write data → release → re-claim → read data | Workload, Claim |

## Kadai Minikube Action Updates

The existing kadai `minikube` action (start cluster + create namespace) additionally needs to:

1. Apply CRDs: `kubectl apply -f apps/operator/crds/`
2. Create ServiceAccount `boilerhouse-operator` in `boilerhouse` namespace
3. Apply RBAC: `kubectl apply -f apps/operator/deploy/rbac.yaml`

These are for the cluster to be operator-ready. The operator process itself is started by the test setup (for tests) or manually by the developer (for dev use).

The action must be idempotent — re-running when the cluster is already up just ensures CRDs and RBAC are current.

## HTTP Connectivity via Port-Forward

The operator creates a ClusterIP Service per managed instance. Tests verify HTTP connectivity using `kubectl port-forward`:

1. Apply Claim, wait for Active
2. Get instanceId from claim status
3. Start `kubectl port-forward svc/<service-name> <local>:<remote>`
4. `fetch("http://localhost:<local>/")` and assert response
5. Stop port-forward

## Out-of-Scope

- No changes to the operator code itself
- No in-cluster operator deployment for tests
- Remove kubernetes option from existing `tests/e2e/` (runtime-matrix, e2e-helpers, fixtures, runtime-detect)
- Add kadai action `e2e-operator` to run operator E2E tests (ensures minikube + CRDs + RBAC are ready, starts operator, runs tests, cleans up)
- No leader election in test setup
