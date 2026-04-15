# Instances

An instance is a running container created from a [workload](./workloads.md) definition. Instances are the units of compute that tenants interact with -- each tenant gets their own isolated container with enforced resource limits, network policies, and filesystem boundaries.

## Lifecycle

Instances move through the following states:

```
starting  -->  active       (boot complete, health checks passing)
restoring -->  active       (snapshot restored, health checks passing)
active    -->  hibernating  (idle timeout or explicit release with hibernate)
active    -->  destroying   (explicit release with destroy)
hibernating -> hibernated   (overlay snapshot saved, container stopped)
hibernated  -> destroyed    (cleanup complete)
destroying  -> destroyed    (teardown complete)
```

| State          | Description                                                |
|----------------|------------------------------------------------------------|
| `starting`     | Container is booting from a fresh image                    |
| `restoring`    | Resuming from a snapshot -- overlay data is being injected |
| `active`       | Running and healthy, accepting traffic                     |
| `hibernating`  | Saving state -- overlay snapshot is in progress            |
| `hibernated`   | State saved, container destroyed                           |
| `destroying`   | Teardown in progress                                       |
| `destroyed`    | Terminal state -- instance no longer exists                 |

::: info
The `hibernated` state is transient. Once the overlay is saved the instance moves to `destroyed`. The tenant's data persists in the snapshot store, not in the instance record.
:::

## Pool Instances vs Claimed Instances

Instances exist in two contexts:

**Pool instances** sit in the warm pool, unclaimed and waiting for a tenant. They have a `pool_status` of `ready` and are not bound to any tenant. The [PoolManager](./pooling.md) maintains these automatically based on the workload's pool configuration.

**Claimed instances** are bound to a tenant through a [claim](./tenants.md). When a tenant claims a workload:

1. If a pool instance is available, it is marked `acquired` and bound to the claim.
2. If no pool instance is available, a new instance is cold-booted.
3. If the tenant has a prior snapshot, the overlay data is restored into the instance.

The PoolManager detects the gap left by the acquired instance and starts a replacement.

## Claiming and Releasing

### Claim

Request a running instance for a tenant:

```
POST /api/v1/tenants/:id/claim
Content-Type: application/json

{ "workload": "my-agent" }
```

Response:

```json
{
  "instanceId": "inst_abc123",
  "endpoint": "http://10.0.0.5:3000",
  "source": "pool",
  "latencyMs": 42
}
```

The `source` field tells you how the instance was provisioned:

| Source        | Description                                              |
|---------------|----------------------------------------------------------|
| `pool`        | Acquired from the warm pool, no prior tenant data        |
| `pool+data`   | Acquired from the warm pool, snapshot restored           |
| `cold`        | Cold-booted on demand, no prior tenant data              |
| `cold+data`   | Cold-booted on demand, snapshot restored                 |
| `existing`    | Tenant already had an active instance for this workload  |

::: tip
If you see `existing`, the tenant already has a running instance for that workload. The same instance is returned without any provisioning.
:::

### Release

Release a tenant's instance:

```
POST /api/v1/tenants/:id/release
Content-Type: application/json

{ "workload": "my-agent" }
```

The release behavior depends on the workload's [idle policy](./workloads.md):

- **`hibernate`** -- snapshots overlay directories, then destroys the container. State is restored on the next claim.
- **`destroy`** -- destroys the container immediately with no snapshot.

## Exec and Logs

### Exec

Run a command inside a running instance:

```
POST /api/v1/instances/:id/exec
Content-Type: application/json

{ "command": ["ls", "-la", "/workspace"] }
```

Response:

```json
{
  "exitCode": 0,
  "stdout": "total 8\ndrwxr-xr-x 2 root root 4096 ...",
  "stderr": ""
}
```

### Logs

Retrieve container logs:

```
GET /api/v1/instances/:id/logs?tail=100
```

Response:

```json
{
  "logs": [
    "2025-01-15T10:30:00Z Starting server on port 3000",
    "2025-01-15T10:30:01Z Health check endpoint ready"
  ]
}
```

::: warning
Both exec and logs require the instance to be in `active` or `restoring` state. Requests against instances in other states return `409 Conflict`.
:::

## Resource Limits

The resource limits declared in the [workload definition](./workloads.md) are enforced by the container runtime:

- **Docker runtime**: `--cpus` for CPU limits, `--memory` for memory limits, and container storage driver quotas for disk.
- **Kubernetes runtime**: Pod `resources.requests` and `resources.limits` for CPU and memory, with ephemeral storage limits for disk.

Processes that exceed memory limits are killed by the runtime (OOMKilled). CPU limits are throttled, not killed.
