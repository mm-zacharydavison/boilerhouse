# Pooling

Pools keep pre-warmed [instances](./instances.md) ready so that tenant claims resolve in milliseconds instead of seconds. Instead of booting a container on demand, Boilerhouse maintains a buffer of healthy instances that can be acquired immediately.

## How Pooling Works

When a [workload](./workloads.md) is registered with a pool configuration:

1. The PoolManager starts warming instances up to `pool.size`.
2. Each instance boots the container, runs health checks, and enters `ready` pool status.
3. When a tenant claims the workload, the nearest ready instance is acquired from the pool and bound to the claim.
4. The PoolManager detects the gap and starts a replacement instance to maintain the target pool size.

This cycle repeats continuously. The pool is always trying to converge on the configured size.

## Configuration

Pool settings live in the [workload definition](./workloads.md):

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "my-agent",
  version: "0.1.0",
  // ... other fields ...
  pool: {
    size: 3,                // Number of warm instances to maintain
    max_fill_concurrency: 2 // Max parallel instance starts during fill
  },
});
```

| Field                  | Default | Description                                      |
|------------------------|---------|--------------------------------------------------|
| `pool.size`            | 3       | Target number of warm, healthy instances          |
| `pool.max_fill_concurrency` | 2  | Maximum parallel instance starts during a fill cycle |

Setting `pool.size` to `0` disables pooling entirely. Every claim triggers a cold boot.

::: tip
Start with a pool size that matches your expected concurrent claim rate. If you typically see 2-3 claims per minute, a pool of 3-5 gives a comfortable buffer. Monitor pool hit rate and adjust.
:::

## Pool Status

Each instance in the pool has a `pool_status` field:

| Status     | Description                                        |
|------------|----------------------------------------------------|
| `warming`  | Container is booting, health checks not yet passed |
| `ready`    | Healthy and available for claims                   |
| `acquired` | Claimed by a tenant, no longer part of the pool    |

Only instances with `pool_status: "ready"` are eligible for claim acquisition. Warming instances are not handed out -- they must pass health checks first.

## Scaling Behavior

The PoolManager runs a continuous reconciliation loop:

1. Count instances with `pool_status` of `ready` or `warming`.
2. If the count is below `pool.size`, calculate the deficit.
3. Start new instances up to `max_fill_concurrency` at a time.
4. Wait for health checks to pass, then mark instances as `ready`.

This means the pool recovers automatically after claims, instance failures, or workload updates.

### Failure Handling

If an instance fails to start or fails health checks:

- The instance is marked as failed and destroyed.
- The PoolManager retries with exponential backoff.
- Persistent failures (e.g., broken Dockerfile, unreachable health endpoint) will keep retrying but will not block other pool operations.

### Workload Updates

When a workload definition is updated (new version, changed config):

1. The workload transitions back to `creating` state.
2. Existing pool instances are drained -- they continue serving active claims but are not returned to the pool on release.
3. New instances are warmed using the updated workload definition.
4. Once the new pool is ready, the workload moves to `ready` state.

This ensures zero-downtime updates: active tenants keep their current instances while the pool transitions to the new version.

## Capacity and Limits

The `MAX_INSTANCES` environment variable caps the total number of instances (pool + claimed) per node. The default is 100.

Pool instances count toward this limit. If you configure 5 workloads each with `pool.size: 10`, that is 50 instances reserved for pools alone, leaving 50 for active claims.

When the node is at capacity:

- New claims return `503 Service Unavailable` with a `Retry-After: 5` header.
- Pool fill operations pause until capacity is available.
- Existing claims and instances are unaffected.

::: warning
Size your pools carefully relative to `MAX_INSTANCES`. Over-provisioned pools leave no room for cold boots or burst traffic. A good rule of thumb: keep total pool instances under 60% of `MAX_INSTANCES`.
:::

### Cold Boot Fallback

When pooling is disabled (`pool.size: 0`) or the pool is empty, claims fall back to cold boot:

1. A new instance is created on demand.
2. The instance boots, runs health checks, and is bound to the claim.
3. The claim response includes `source: "cold"` (or `"cold+data"` if a snapshot was restored).

Cold boot latency depends on the image size, health check configuration, and runtime. Typical cold boots range from 2-15 seconds for Docker and 5-30 seconds for Kubernetes.
