# Instances

An instance is a running Pod managed by Boilerhouse. Instances are created from `BoilerhouseWorkload` specs, assigned to tenants via `BoilerhouseClaim` resources, and eventually hibernated or destroyed.

Boilerhouse instances are always Pods labeled `boilerhouse.dev/managed=true`. You can list them with either `kubectl` or the API.

## Lifecycle

The lifecycle is driven by two state machines: the Pod's own phase and the `BoilerhouseClaim` phase that owns it.

```
Pod: Pending ──► Running ──► Succeeded / Failed
Claim: Pending ──► Active ──► Releasing ──► Released
```

| Claim Phase | Meaning |
|-------------|---------|
| `Pending` | Claim created; controller is selecting or starting a Pod |
| `Active` | Pod is running, healthy, and bound to this tenant |
| `Releasing` | Tenant released; overlay is being extracted |
| `Released` | Overlay saved, Pod destroyed |
| `ReleaseFailed` | Overlay extraction failed; manual cleanup may be required |
| `Error` | Claim could not be fulfilled |

See [State Machines](../reference/state-machines) for the full reference.

## Claiming and Releasing

Instances are acquired through the **claim** mechanism. You don't create instances directly — you claim one for a tenant, and the operator decides how to provide it.

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
  "phase": "Active",
  "instanceId": "inst-user-123-my-agent-a1b2c3",
  "endpoint": { "host": "10.244.0.12", "port": 8080 },
  "source": "pool",
  "claimedAt": "2026-04-20T10:30:00Z"
}
```

The `source` tells you which path the controller took:

| Source | Meaning | Typical Latency |
|--------|---------|----------------|
| `existing` | Tenant already had a running instance | <100ms |
| `pool` | Acquired from a pre-warmed pool | 200-800ms |
| `pool+data` | Pool instance with tenant overlay restored | 500-2000ms |
| `cold` | New Pod booted from scratch | 2-10s |
| `cold+data` | New Pod with tenant overlay restored | 3-15s |

### Release

```bash
curl -X POST http://localhost:3000/api/v1/tenants/user-123/release \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

Release triggers the operator to:
1. Mark the claim as `Releasing`
2. Extract overlay directories as a tar archive via a helper Pod
3. Save the archive to the snapshots PVC
4. Destroy the Pod
5. Mark the claim as `Released` (then delete it)
6. Replenish the pool if one is configured

## Exec

Run commands inside a running instance:

```bash
curl -X POST http://localhost:3000/api/v1/instances/<id>/exec \
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

The API server shells out to `kubectl exec` under the hood, so your kubeconfig must be reachable from wherever the API runs.

## Logs

Retrieve container logs:

```bash
curl http://localhost:3000/api/v1/instances/<id>/logs?tail=100
```

Returns raw text. The `tail` query parameter limits the number of lines.

## Destroy

Force-destroy a Pod without extracting overlays:

```bash
curl -X POST http://localhost:3000/api/v1/instances/<id>/destroy
```

This skips the hibernation flow and deletes the Pod immediately. The claim is left in whatever phase it was in — normally you'd release the tenant first.

## Listing Instances

```bash
# All managed pods
curl http://localhost:3000/api/v1/instances

# Or just use kubectl
kubectl get pods -n boilerhouse -l boilerhouse.dev/managed=true
```

Each response entry includes:

```json
{
  "name": "inst-alice-my-agent-a1b2c3",
  "phase": "Running",
  "tenantId": "alice",
  "workloadRef": "my-agent",
  "ip": "10.244.0.12",
  "labels": {
    "boilerhouse.dev/managed": "true",
    "boilerhouse.dev/workload": "my-agent",
    "boilerhouse.dev/tenant": "alice"
  },
  "createdAt": "2026-04-20T10:29:55Z",
  "lastActivity": "2026-04-20T10:35:00Z",
  "claimedAt": "2026-04-20T10:30:00Z"
}
```

## Labels

Every managed Pod carries a standard set of labels the operator uses for reconciliation and that you can query with kubectl:

| Label | Meaning |
|-------|---------|
| `boilerhouse.dev/managed` | Always `true` for managed instances |
| `boilerhouse.dev/workload` | Name of the `BoilerhouseWorkload` |
| `boilerhouse.dev/tenant` | Tenant ID (only on claimed Pods) |
| `boilerhouse.dev/pool` | Pool name (only on warm Pods) |
| `boilerhouse.dev/pool-status` | `warming` or `ready` |

## Capacity

Instance count is bounded by the cluster's resource quota. Unlike the old `MAX_INSTANCES` setting, scheduling is now Kubernetes' job — if no node can fit the Pod, it stays `Pending` until one can.

For hard caps, apply a `ResourceQuota` or `LimitRange` to the `boilerhouse` namespace.
