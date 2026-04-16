# Tenants & Claims

Boilerhouse is multi-tenant by design. Every running instance is associated with a tenant, and tenants interact with instances through the **claim** system.

## What is a Tenant?

A tenant is an identity — a user, an organization, or any entity that needs its own isolated container. Tenant IDs are free-form strings that can be anything printable:

- `user-123` — internal user ID
- `slack-U12345` — Slack user ID from a trigger
- `tg-jane` — Telegram username from a trigger
- `org:acme` — organization identifier

Tenant IDs must match `[a-zA-Z0-9._@:-]{1,256}`.

## Claims

A **claim** is a tenant's active lease on an instance. A tenant can have one claim per workload at a time.

### Claiming

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/claim \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

When a tenant claims an instance, Boilerhouse picks the fastest available path:

1. **Existing** — the tenant already has a running instance for this workload. Returns immediately.
2. **Pool** — a pre-warmed instance is available. Acquired from the pool.
3. **Pool+data** — pool instance with the tenant's previous overlay data injected.
4. **Cold** — no pool available. A new instance is created from scratch.
5. **Cold+data** — cold boot with the tenant's previous overlay data restored.

The claim response includes a `source` field so you know which path was taken:

```json
{
  "tenantId": "alice",
  "instanceId": "inst_abc123",
  "endpoint": { "host": "127.0.0.1", "ports": [30042] },
  "source": "pool+data",
  "latencyMs": 1200,
  "websocket": "/ws"
}
```

### Releasing

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/release \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

Release extracts the tenant's overlay data and either hibernates or destroys the instance (depending on the workload's `idle.action` setting and whether overlay extraction succeeded).

### Idle Release

If the workload has an idle timeout configured, Boilerhouse automatically releases the claim when the timeout fires. No manual release call is needed.

### Claim Status

```
creating ──► active ──► releasing ──► released
```

## Tenant State

Query a tenant's current state across all workloads:

```bash
curl http://localhost:3000/api/v1/tenants/alice
```

```json
[
  {
    "tenantId": "alice",
    "workloadId": "wkl_abc",
    "instanceId": "inst_123",
    "lastSnapshotId": "snap_456",
    "dataOverlayRef": "tenants/alice/wkl_abc/overlay.tar.gz",
    "lastActivity": "2024-01-15T10:35:00.000Z",
    "instance": {
      "instanceId": "inst_123",
      "status": "active",
      "createdAt": "2024-01-15T10:30:00.000Z"
    },
    "snapshots": [
      {
        "snapshotId": "snap_456",
        "type": "tenant",
        "createdAt": "2024-01-15T09:00:00.000Z"
      }
    ]
  }
]
```

A tenant can have entries for multiple workloads — for example, one claim on `claude-code` and another on `openclaw`.

## Secrets

Boilerhouse supports per-tenant encrypted secrets. These are used for credential injection via the Envoy sidecar proxy.

### Storing a Secret

```bash
curl -X PUT http://localhost:3000/api/v1/tenants/alice/secrets/ANTHROPIC_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-ant-..."}'
```

### Listing Secrets

```bash
curl http://localhost:3000/api/v1/tenants/alice/secrets
```

Returns secret names (not values):

```json
{
  "secrets": ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]
}
```

### Deleting a Secret

```bash
curl -X DELETE http://localhost:3000/api/v1/tenants/alice/secrets/ANTHROPIC_API_KEY
```

Secrets are encrypted at rest using AES-GCM with the `BOILERHOUSE_SECRET_KEY`.

## Data Isolation

Boilerhouse provides several layers of tenant isolation:

### Filesystem Isolation

Each tenant's data is stored in separate overlay archives. Overlay directories declared in the workload config (`filesystem.overlay_dirs`) are extracted and stored per-tenant. One tenant cannot access another tenant's overlay data.

### Network Isolation

Each container runs with its own network namespace. In restricted mode, an Envoy sidecar enforces domain allowlists per-container. Network policies (on Kubernetes) add an additional layer of isolation.

### Credential Scoping

Credentials injected via `network.credentials` are applied per-container. The Envoy sidecar injects headers only for the specified domains.

### Container Isolation

Each tenant gets their own container with:
- Dropped Linux capabilities (`CAP_DROP=ALL`)
- Seccomp profiles limiting system calls
- No privilege escalation (`no_new_privileges`)
- Resource limits (CPU, memory, disk)
