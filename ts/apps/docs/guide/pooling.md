# Pooling

Pooling lets you pre-warm Pods so tenants get near-instant claim times instead of waiting for a cold boot.

## How Pooling Works

When you create a `BoilerhousePool` for a workload, the operator maintains a set of pre-warmed Pods labeled `boilerhouse.dev/pool-status`:

1. **Warming** — on startup (or when the pool drops below target), the operator creates Pods up to `size`
2. **Ready** — once the Pod's readiness probe passes, the pool-status label flips to `ready`
3. **Acquire** — when a tenant claims, the `ClaimReconciler` grabs a `ready` Pod by relabeling it with `boilerhouse.dev/tenant=<id>`
4. **Replenish** — after acquisition, the pool controller spawns a replacement to get back to `size`

```
warming ──► ready ──► acquired (relabel to tenant)
                          │
                          ▼
                  Pool refills to target size
```

Without pooling, a claim requires a cold boot (2-10+ seconds depending on image). With pooling, claims complete in 200-800ms since the Pod is already running and healthy.

## Configuration

Create a `BoilerhousePool` referencing the workload by name:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhousePool
metadata:
  name: my-agent-pool
  namespace: boilerhouse
spec:
  workloadRef: my-agent
  size: 5
  maxFillConcurrency: 3
```

| Field | Description |
|-------|-------------|
| `workloadRef` | Name of the `BoilerhouseWorkload` to pool |
| `size` | Target number of warm Pods |
| `maxFillConcurrency` | Max Pods that can be warming simultaneously (optional, default unbounded) |

Decoupling pools from workloads lets cluster admins tune pool sizes independently from workload authors.

## Pool Status

The pool controller writes observed state to `.status`:

```bash
kubectl get boilerhousepools -n boilerhouse
```

```
NAME            WORKLOAD   SIZE   READY   PHASE
my-agent-pool   my-agent   5      5       Healthy
```

```bash
kubectl describe boilerhousepool my-agent-pool -n boilerhouse
```

```yaml
status:
  ready: 4
  warming: 1
  phase: Healthy
```

Phase values:
- `Healthy` — pool is at or above target size
- `Degraded` — some instances are not ready
- `Error` — pool cannot reach target size (e.g., workload missing, image pull failure)

## Scaling Behavior

The pool controller continuously reconciles actual count against `size`:

- If `ready + warming < size`, new Pods are created (up to `maxFillConcurrency` at a time)
- If a pool Pod fails its readiness probe, it is deleted and replaced
- After a tenant claim acquires a Pod, replenishment starts immediately
- Deleting the `BoilerhousePool` drains all warm Pods (claimed Pods are untouched)

The pool controller does **not** scale beyond `size`. It maintains a fixed target, not an autoscaling range.

## Capacity Limits

Pool Pods consume regular Kubernetes scheduling — they count against your `ResourceQuota` and any node capacity. If no node can fit a new Pod:
- Replenishment is deferred until capacity frees up (Pods remain `Pending`)
- New claims fall back to cold boot if no pool Pods are available
- Claims can time out if neither path produces a running Pod in 30 seconds

## When to Use Pooling

Pool when:
- Your workload takes more than 1-2 seconds to boot and become healthy
- Claim latency matters (user-facing, interactive agents)
- You have enough node capacity to keep warm Pods running

Skip pooling when:
- Your workload boots in under a second
- Resource efficiency matters more than latency
- You have very few concurrent tenants

## Inspecting Pool Pods

Pool Pods are just Pods labeled `boilerhouse.dev/pool=<pool-name>`:

```bash
kubectl get pods -n boilerhouse -l boilerhouse.dev/pool=my-agent-pool
```

Once a tenant claims a warm Pod, the `boilerhouse.dev/pool-status` label is removed and `boilerhouse.dev/tenant=<id>` is added.
