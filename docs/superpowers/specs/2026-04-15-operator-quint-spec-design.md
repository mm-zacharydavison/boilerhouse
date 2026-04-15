# Boilerhouse Operator Quint Formal Specification

## Goal

Write Quint formal specifications for the Boilerhouse Kubernetes operator to discover logical bugs — particularly concurrency issues between controllers. The spec will serve as a ground truth model of the operator's logic, maintained alongside the code.

There is a failing e2e test (`tests/e2e-operator/destroy.e2e.test.ts`) where a workload is not deleted after its claim is released. The spec should be able to reproduce and diagnose this.

## Approach

Layered modules composed into a single system model. Each module maps to a layer of the operator codebase.

## File Structure

```
specs/quint/
  state_machines.qnt    — Pure state machine transitions (Instance, Claim, Workload, Tenant)
  db.qnt                — DB tables as maps, constraints, atomic CRUD operations
  controllers.qnt       — Controller queues, multi-step reconcile logic with yield points
  operator.qnt          — Composition: system step = nondeterministic choice of controller actions
  invariants.qnt        — Safety properties checked with quint verify
  tests.qnt             — Witness runs and scenario tests (including destroy sequence)
```

## Layer 1: State Machines (`state_machines.qnt`)

Direct translation of the transition maps from `packages/core/src/*-state.ts`.

### Types

```
InstanceStatus = Starting | Restoring | Active | Hibernating | Hibernated | Destroying | Destroyed
InstanceEvent  = Started | IRestoring | Restored | Hibernate | Hibernated | HibernatingFailed | Destroy | IDestroyed | Recover

ClaimStatus = Creating | ClaimActive | Releasing
ClaimEvent  = Created | Release | ClaimRecover

WorkloadStatus = WCreating | Ready | WError
WorkloadEvent  = WCreated | Failed | Retry | WRecover

TenantStatus = Idle | Claiming | TActive | TReleasing | Released
TenantEvent  = Claim | Claimed | ClaimFailed | TRelease | THibernated | TDestroyed | TRecover
```

### Transition Functions

Each is a pure function `(status, event) -> Option[Status]` returning `None` for invalid transitions. Exact maps:

**Instance:**
- `starting`:    `Started -> Active`, `IRestoring -> Restoring`, `Destroy -> Destroying`, `Recover -> Destroyed`
- `restoring`:   `Restored -> Active`, `Destroy -> Destroying`
- `active`:      `Hibernate -> Hibernating`, `Destroy -> Destroying`, `Recover -> Destroyed`
- `hibernating`: `Hibernated -> Hibernated`, `HibernatingFailed -> Destroying`
- `hibernated`:  `IRestoring -> Restoring`, `Destroy -> Destroying`
- `destroying`:  `IDestroyed -> Destroyed`
- `destroyed`:   (no transitions)

**Claim:**
- `creating`:  `Created -> ClaimActive`
- `active`:    `Release -> Releasing`
- `releasing`: `ClaimRecover -> ClaimActive`

**Workload:**
- `creating`: `WCreated -> Ready`, `Failed -> WError`
- `ready`:    `WRecover -> WCreating`
- `error`:    `Retry -> WCreating`

**Tenant:**
- `idle`:      `Claim -> Claiming`
- `claiming`:  `Claimed -> TActive`, `ClaimFailed -> Idle`
- `active`:    `Claim -> Claiming`, `TRelease -> TReleasing`
- `releasing`: `THibernated -> Released`, `TDestroyed -> Idle`, `TRecover -> TActive`
- `released`:  `Claim -> Claiming`

### Excluded

Snapshot and Node state machines are excluded. Snapshot is a data-persistence side-effect that doesn't affect controller coordination logic. Node/leader-election is a separate concern to model later if needed.

## Layer 2: DB (`db.qnt`)

Models the SQLite tables as Quint maps. Operations are atomic (matching drizzle `.run()` semantics).

### State Variables

```
var workloadDb: WorkloadId -> { name: str, status: WorkloadStatus }
var instanceDb: InstanceId -> { workloadId: WorkloadId, status: InstanceStatus, poolStatus: PoolStatus }
var claimDb:    ClaimId -> { tenantId: TenantId, workloadId: WorkloadId, instanceId: InstanceId, status: ClaimStatus }
var tenantDb:   TenantId -> { workloadId: WorkloadId, hasOverlayData: bool }
```

`PoolStatus` is a sum type: `Warming | PoolReady | Acquired | NotInPool`.

### DB Constraints (checked as invariants, not enforced)

1. **Claim uniqueness**: No two claims share `(tenantId, workloadId)`
2. **Instance FK**: Every `claim.instanceId` exists in `instanceDb`
3. **Workload FK**: Every `instance.workloadId` and `claim.workloadId` exists in `workloadDb`

### Operations

Atomic actions: `insertClaim`, `deleteClaim`, `insertInstance`, `deleteInstance`, `upsertWorkload`, `deleteWorkload`, `updateInstanceStatus`, `updateClaimStatus`, `updatePoolStatus`.

## Layer 3: Controllers (`controllers.qnt`)

### Controller Queues

```
var workloadQueue: Set[{ name: str, retries: int }]
var claimQueue:    Set[{ name: str, retries: int }]
var poolQueue:     Set[{ name: str, retries: int }]
```

Simplified from the real controller: we drop `nextAttempt` timing and model backoff as "item is in queue and may be processed." We keep `retries` and `maxRetries` (20 for workload/claim, 5 for pool) to model the drop-after-max-retries behavior.

Enqueue with dedup: if item already in queue, replace it. If `resetRetries`, set retries to 0.

### Multi-Step Reconciliation

Controller reconciles are NOT atomic. They're broken into steps with yield points where other controllers can interleave. Each controller has a reconcile phase variable:

```
var workloadReconcilePhase: WIdle | WReadClaims(name: str, claims: Set[ClaimId]) | WDeleteOrFinalize(name: str)
var claimReconcilePhase:    CIdle | CReleasing(name: str) | CRemovingFinalizer(name: str) | CReEnqueueWorkload(name: str)
```

**Workload reconcile (deletion path):**
1. `WIdle` -> pick item from queue, read linked claims from DB -> `WReadClaims(name, claimIds)`
2. `WReadClaims` -> if claims non-empty: requeue with retries+1 (or drop if max), back to `WIdle`
3. `WReadClaims` -> if claims empty: delete instances + workload from DB, remove finalizer -> `WIdle`

The TOCTOU race: between step 1 (read claims) and step 3 (delete workload), a new claim can be created by the claim controller.

**Claim reconcile (deletion path):**
1. `CIdle` -> pick item from queue -> `CReleasing(name)`
2. `CReleasing` -> delete claim from DB, update instance status to Destroying -> `CRemovingFinalizer(name)`
3. `CRemovingFinalizer` -> remove claim CRD finalizer -> `CReEnqueueWorkload(name)`
4. `CReEnqueueWorkload` -> nondeterministically succeed or fail to re-enqueue workload -> `CIdle`

Step 4 models the silent failure at bootstrap.ts:317-326.

**Pool reconcile:**
1. Count ready + warming instances for workload
2. If below target: start new instances (insert into DB with status Starting, poolStatus Warming)
3. Health check completes: transition to Active, poolStatus Ready

## Layer 4: Composition (`operator.qnt`)

### System Step

```
action step = any {
  // Controller processing
  workloadControllerStep,
  claimControllerStep,
  poolControllerStep,

  // External events (user actions)
  externalClaimCreate,       // user creates a claim CRD
  externalClaimDelete,       // user deletes a claim CRD
  externalWorkloadCreate,    // user creates a workload CRD
  externalWorkloadDelete,    // user deletes a workload CRD

  // Background processes
  poolReplenish,             // pool manager starts a new instance
  poolAcquire,               // pool manager hands instance to a claim
  idleTimeout,               // idle monitor fires
  instanceHealthCheckPass,   // warming instance becomes ready
  instanceCrash,             // running instance crashes
}
```

Each step is a nondeterministic choice. The model checker explores all interleavings.

### CRD State (minimal K8s)

```
var crdWorkloads: str -> { deletionTimestamp: bool, hasFinalizer: bool, statusPhase: CrdPhase }
var crdClaims:    str -> { deletionTimestamp: bool, hasFinalizer: bool, statusPhase: CrdPhase }
```

CrdPhase = `Pending | Active | Ready | Error | Released`.

K8s deletion semantics: a CRD with `deletionTimestamp = true` and `hasFinalizer = false` is removed from the map.

### State Space Bounds

To keep verification tractable:
- 2 workloads max
- 3 tenants max
- Pool target size of 2
- MaxRetries reduced to 3 (same behavior, smaller state space)

## Layer 5: Invariants (`invariants.qnt`)

### Safety Invariants (SATISFIED = good)

1. **claimUniqueness** — `forall c1, c2 in claimDb: (c1.tenantId == c2.tenantId and c1.workloadId == c2.workloadId) implies c1 == c2`
2. **noOrphanedInstances** — `forall i in instanceDb: i.workloadId in workloadDb.keys()`
3. **activeClaimHasLiveInstance** — `forall c in claimDb where c.status == ClaimActive: c.instanceId in instanceDb.keys() and instanceDb[c.instanceId].status != Destroyed`
4. **workloadDeletionSafety** — After workload is deleted from DB, no claims reference its workloadId
5. **poolSizeBound** — `forall wId: count(instances where workloadId == wId and poolStatus in {Warming, PoolReady}) <= 2 * targetSize`
6. **finalizerConsistency** — If CRD has `deletionTimestamp` and no finalizer, it is removed from the CRD map

### Liveness (modeled as witnesses)

7. **noStuckFinalizers** — If a workload CRD has `deletionTimestamp` and all its claims are deleted, the finalizer is eventually removed

## Layer 6: Tests (`tests.qnt`)

### Witnesses (VIOLATED = good — confirms reachability)

1. **destroySequence** — The exact e2e test: create workload, create claim, delete workload, delete claim, workload finalizer removed
2. **destroyWithFailedReEnqueue** — Same but re-enqueue fails. Does the workload finalizer ever get removed via backoff retry?
3. **poolOvershoot** — Replenish and acquire interleave to exceed targetSize
4. **staleClaimAfterCrash** — Recovery reconciles stale claim state
5. **idleReleaseRace** — Idle timeout and explicit release fire concurrently

### Scenario Test Runs

```
run destroyE2ETest =
  createWorkload("wl1")
    .then(workloadReconcileToReady("wl1"))
    .then(createClaim("c1", "t1", "wl1"))
    .then(claimReconcileToActive("c1"))
    .then(deleteWorkload("wl1"))
    .then(workloadReconcileBlocked("wl1"))   // reads claims, finds c1, returns Error
    .then(deleteClaim("c1"))
    .then(claimDeleteFromDb("c1"))           // tenantManager.release() deletes claim row
    .then(claimDestroyInstance("c1"))        // instance status -> Destroying -> Destroyed
    .then(claimRemoveFinalizer("c1"))        // claim CRD finalizer removed, claim CRD gone
    .then(claimReEnqueueWorkload("wl1"))     // re-enqueue with resetRetries=true
    .then(workloadReconcileFinalize("wl1"))  // reads claims (none), deletes DB rows, removes finalizer
```

```
run destroyWithFailedReEnqueue =
  createWorkload("wl1")
    .then(workloadReconcileToReady("wl1"))
    .then(createClaim("c1", "t1", "wl1"))
    .then(claimReconcileToActive("c1"))
    .then(deleteWorkload("wl1"))
    .then(workloadReconcileBlocked("wl1"))
    .then(deleteClaim("c1"))
    .then(claimDeleteFromDb("c1"))
    .then(claimDestroyInstance("c1"))
    .then(claimRemoveFinalizer("c1"))
    .then(claimReEnqueueWorkloadFails("wl1"))  // kubeList fails silently
    .then(workloadRetryFromBackoff("wl1"))     // depends on existing queue entry
    .then(workloadReconcileFinalize("wl1"))
```

## Suspected Bugs to Verify

### 1. Workload Finalizer Stuck After Claim Deletion (the failing e2e test)

**Hypothesis**: After claim deletion, the workload controller is not re-triggered reliably. The re-enqueue at bootstrap.ts:317-326 can fail silently (kubeList error, workload not found). If it fails, the workload depends on its existing backoff retry in the queue. If that retry has already been consumed or dropped, the workload finalizer is never removed.

**What the spec will show**: Whether `destroyWithFailedReEnqueue` can reach `workloadReconcileFinalize` — i.e., whether backoff alone is sufficient.

### 2. TOCTOU: Workload Deletion vs Claim Creation

**Hypothesis**: Workload controller reads "no claims", yields, claim controller creates a claim, workload controller deletes the workload. Claim now references a non-existent workload.

**What the spec will show**: Whether `noOrphanedInstances` or `workloadDeletionSafety` invariants are violated.

### 3. Pool Overshoot

**Hypothesis**: Concurrent `replenish()` and `acquire()` both count pool instances and both start new ones, temporarily exceeding targetSize.

**What the spec will show**: Whether `poolSizeBound` is violated with the relaxed 2x bound.

### 4. Claim Finalized With Dead Instance

**Hypothesis**: Instance crashes between pool acquisition and claim finalization. Claim is marked Active but points to a Destroyed instance.

**What the spec will show**: Whether `activeClaimHasLiveInstance` is violated.

## Maintenance

The spec maps directly to operator source code:
- `state_machines.qnt` mirrors `packages/core/src/*-state.ts`
- `controllers.qnt` mirrors `apps/operator/src/*-controller.ts` + `bootstrap.ts`
- `db.qnt` mirrors `packages/db/src/schema.ts`

When operator logic changes, the corresponding Quint module should be updated and `quint test --match` run to verify consistency.
