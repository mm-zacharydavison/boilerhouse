# Instances

An instance is a running container managed by Boilerhouse. Instances are created from workload definitions, assigned to tenants via claims, and eventually hibernated or destroyed.

## Lifecycle

Every instance progresses through a state machine:

```
starting ──► active ──► hibernating ──► hibernated
                │
                └──► destroying ──► destroyed
```

| Status | Description |
|--------|-------------|
| `starting` | Container is being created by the runtime (Docker or K8s). Health checks are running. |
| `active` | Container is running, healthy, and assigned to a tenant. |
| `hibernating` | Tenant overlay is being extracted. Container is about to shut down. |
| `hibernated` | Container destroyed. Overlay data saved to storage for future restoration. |
| `destroying` | Container is being torn down. |
| `destroyed` | Container fully removed. No data retained. |

The transition from `starting` to `active` happens automatically once health checks pass. The transition from `active` to `hibernating` or `destroying` is triggered by tenant release or idle timeout.

## Claiming and Releasing

Instances are acquired through the **claim** mechanism. You don't create instances directly — you claim one for a tenant, and Boilerhouse decides how to provide it.

### Claim

```bash
curl -X POST http://localhost:3000/api/v1/tenants/user-123/claim \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

Response:

```json
{
  "tenantId": "user-123",
  "instanceId": "inst_abc123",
  "endpoint": { "host": "127.0.0.1", "ports": [30042] },
  "source": "pool",
  "latencyMs": 450,
  "websocket": "/ws"
}
```

The `source` tells you which path was taken:

| Source | Meaning | Typical Latency |
|--------|---------|----------------|
| `existing` | Tenant already had a running instance | <10ms |
| `pool` | Acquired from pre-warmed pool | 200-800ms |
| `pool+data` | Pool instance with tenant overlay restored | 500-2000ms |
| `cold` | New container booted from scratch | 2-10s |
| `cold+data` | New container with tenant overlay restored | 3-15s |

### Release

```bash
curl -X POST http://localhost:3000/api/v1/tenants/user-123/release \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

Release performs these steps:
1. Pauses the container (if the runtime supports it)
2. Extracts overlay directories as a tar archive
3. Saves the archive to blob storage (with optional encryption)
4. Destroys the container (hibernation) or marks it destroyed
5. Replenishes the pool if configured

## Exec

Run commands inside a running instance:

```bash
curl -X POST http://localhost:3000/api/v1/instances/inst_abc123/exec \
  -H "Content-Type: application/json" \
  -d '{"command": ["ls", "-la", "/workspace"]}'
```

```json
{
  "exitCode": 0,
  "stdout": "total 8\ndrwxr-xr-x 2 root root 4096 ...",
  "stderr": ""
}
```

The instance must be in `active` status. The `command` field is an array of strings (not a shell command — use `["sh", "-c", "your command"]` for shell features).

## Logs

Retrieve container logs:

```bash
curl http://localhost:3000/api/v1/instances/inst_abc123/logs?tail=100
```

```json
{
  "instanceId": "inst_abc123",
  "logs": "2024-01-15T10:30:00Z Starting server...\n..."
}
```

The `tail` parameter controls how many lines to return (default: 200, max: 5000). Logs are only available while the container is running — hibernated and destroyed instances have no logs.

## Destroy

Force-destroy an instance without extracting overlays:

```bash
curl -X POST http://localhost:3000/api/v1/instances/inst_abc123/destroy
```

This skips the hibernation flow and immediately tears down the container.

## Hibernate

Trigger hibernation (extract overlay + destroy) for a specific instance:

```bash
curl -X POST http://localhost:3000/api/v1/instances/inst_abc123/hibernate
```

This releases the tenant's claim, extracts the overlay, and hibernates the instance.

## Endpoint

Get the network endpoint for a running instance:

```bash
curl http://localhost:3000/api/v1/instances/inst_abc123/endpoint
```

```json
{
  "instanceId": "inst_abc123",
  "status": "active",
  "endpoint": { "host": "127.0.0.1", "ports": [30042] }
}
```

Pool instances (not yet claimed) do not expose endpoints.

## Resource Limits

Resources are enforced at the runtime level:

- **Docker** — CPU and memory limits set via Docker's resource constraints. Disk limits via storage driver quotas.
- **Kubernetes** — CPU and memory set as Pod resource requests and limits. Disk via emptyDir size limits.

If a node is at capacity (`MAX_INSTANCES` reached), new claims return `503 Service Unavailable` with a `Retry-After` header.

## Listing Instances

```bash
# All instances
curl http://localhost:3000/api/v1/instances

# Filter by status
curl http://localhost:3000/api/v1/instances?status=active
```

Each instance in the response includes:

```json
{
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz",
  "nodeId": "node_1",
  "tenantId": "user-123",
  "status": "active",
  "hasSidecar": true,
  "lastActivity": "2024-01-15T10:35:00.000Z",
  "claimedAt": "2024-01-15T10:30:00.000Z",
  "createdAt": "2024-01-15T10:29:55.000Z"
}
```
