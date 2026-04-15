# Pooling

Pooling lets you pre-warm container instances so tenants get near-instant claim times instead of waiting for a cold boot.

## How Pooling Works

When a workload has a `pool` configuration, Boilerhouse maintains a set of pre-warmed instances:

1. **Fill** — on startup (or when pool drops below target), Boilerhouse creates instances up to `size`
2. **Health check** — each pool instance runs through the workload's health check
3. **Ready** — healthy instances sit idle in the pool, ready for acquisition
4. **Acquire** — when a tenant claims, a pool instance is grabbed instead of cold-booting
5. **Replenish** — after acquisition, the pool is refilled back to target size

```
Pool lifecycle:

  warming ──► ready ──► acquired (by tenant claim)
                            │
                            ▼
                    Pool refills to target size
```

Without pooling, a claim requires a cold boot (2-10+ seconds depending on image). With pooling, claims complete in 200-800ms since the container is already running and healthy.

## Configuration

Add a `pool` section to your workload definition:

```typescript
export default defineWorkload({
  name: "my-agent",
  version: "1.0.0",
  image: { ref: "my-registry/my-agent:latest" },
  resources: { vcpus: 2, memory_mb: 2048 },
  // ... other config ...
  pool: {
    size: 3,                  // maintain 3 warm instances
    max_fill_concurrency: 2,  // create at most 2 at a time
  },
});
```

### Kubernetes (CRD)

In the Kubernetes operator, pools are a separate resource:

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

This decouples pool sizing from workload definition, allowing cluster admins to tune pool sizes independently.

## Pool Status

Pool instances go through three statuses:

| Status | Meaning |
|--------|---------|
| `warming` | Instance is starting up and running health checks |
| `ready` | Instance is healthy and available for acquisition |
| `acquired` | Instance has been claimed by a tenant (removed from pool) |

You can see pool status in the Kubernetes operator's `BoilerhousePool` status:

```yaml
status:
  ready: 3
  warming: 1
  phase: Healthy
```

Phase values:
- `Healthy` — pool is at or above target size
- `Degraded` — some instances are not ready
- `Error` — pool cannot reach target size

## Scaling Behavior

The pool manager continuously reconciles the actual count against the desired `size`:

- If `ready + warming < size`, new instances are created (up to `max_fill_concurrency` at a time)
- If a pool instance fails health checks, it is destroyed and replaced
- After a tenant claim acquires an instance, replenishment starts immediately
- Pool drain (on workload deletion or pool deletion) destroys all pool instances

The pool manager does **not** scale beyond the configured `size`. It maintains a fixed target, not an autoscaling range.

## Capacity Limits

Pool instances count against the node's `MAX_INSTANCES` limit. If a node is at capacity:
- Pool replenishment is deferred until capacity frees up
- New claims may fall back to cold boot if no pool instances are available
- The claim endpoint returns `503 Service Unavailable` only if both pool and cold boot paths are unavailable

## When to Use Pooling

Pool when:
- Your workload takes more than 1-2 seconds to boot and become healthy
- Claim latency matters (user-facing, interactive agents)
- You have enough resources to keep warm instances running

Skip pooling when:
- Your workload boots in under a second
- Resource efficiency matters more than latency
- You have very few concurrent tenants
