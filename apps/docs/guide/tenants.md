# Tenants

A tenant represents a user, agent, or session that owns running [instances](./instances.md). Boilerhouse's multi-tenancy model ensures that each tenant gets isolated compute, storage, and network resources with no cross-tenant data leakage.

## Multi-Tenancy Model

Tenants are identified by a string ID matching the pattern `^[a-zA-Z0-9._@:-]{1,256}$`. This is deliberately flexible -- tenant IDs can be:

- Email addresses (`alice@example.com`)
- User IDs (`user_abc123`)
- Chat usernames (`slack:alice`)
- Session identifiers (`session:2025-01-15:xyz`)

Any string that fits the pattern works. Boilerhouse does not manage authentication -- it trusts the caller to provide the correct tenant ID.

Each tenant can have **one active claim per workload** at a time. If a tenant claims the same workload twice, they get back the same instance (the response will have `source: "existing"`). A tenant can hold claims across multiple workloads simultaneously.

## Claims

A claim is the binding between a tenant and an [instance](./instances.md). It tracks the lifecycle of that relationship.

Claims have three states:

| State       | Description                                          |
|-------------|------------------------------------------------------|
| `creating`  | Finding or starting an instance for the tenant       |
| `active`    | Tenant has a running, healthy instance               |
| `releasing` | Instance is being released (hibernate or destroy)    |

```
creating  -->  active     (instance ready)
active    -->  releasing  (release requested or idle timeout)
releasing -->  active     (hibernation recovery: re-claim before teardown completes)
```

::: info
The `releasing -> active` transition handles the case where a tenant reclaims a workload while hibernation is still in progress. The release is cancelled and the existing instance is kept alive.
:::

## Secrets

Tenants can store encrypted secrets that are injected into their containers at claim time. This is the mechanism for providing API keys, tokens, and other credentials without baking them into the workload image.

### Set a Secret

```
PUT /api/v1/tenants/:id/secrets/:name
Content-Type: application/json

{ "value": "sk-ant-abc123..." }
```

### List Secrets

```
GET /api/v1/tenants/:id/secrets
```

Returns secret names only -- values are never returned through the API.

```json
{
  "secrets": ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]
}
```

### Delete a Secret

```
DELETE /api/v1/tenants/:id/secrets/:name
```

### How Secrets Are Stored

Secrets are encrypted at rest using AES-256-GCM with the key from `BOILERHOUSE_SECRET_KEY`. Each secret gets a unique nonce. The plaintext value never touches disk unencrypted.

### How Secrets Are Injected

Secrets are referenced in [workload network credentials](./workloads.md) using the `${tenant-secret:NAME}` placeholder syntax:

```typescript
network: {
  access: "restricted",
  allowed_hosts: ["api.anthropic.com"],
  credentials: [
    {
      host: "api.anthropic.com",
      headers: {
        "x-api-key": "${tenant-secret:ANTHROPIC_API_KEY}",
      },
    },
  ],
}
```

When the tenant claims this workload, the Envoy sidecar is configured to inject the resolved secret value into outbound requests matching the specified host. The secret value is resolved at claim time and passed to the sidecar -- it is not exposed as an environment variable inside the container.

::: warning
If a referenced secret does not exist for the tenant at claim time, the claim will fail with a `400 Bad Request` error listing the missing secrets.
:::

## Snapshots

When an instance is released with `action: "hibernate"`:

1. The workload's `overlay_dirs` are captured as a tar archive from the running container.
2. The archive is encrypted (if `encrypt_overlays` is enabled) and stored in the blob store.
3. The tenant's `data_overlay_ref` is updated to point to the new snapshot.
4. The instance is destroyed.

On the next claim, the snapshot is restored into the new instance's overlay directories before the container starts accepting traffic. This means tenants accumulate state across sessions -- files created, databases populated, configuration written -- all persist transparently.

See [Snapshots](./snapshots.md) for storage backend details and the full snapshot lifecycle.

## Data Isolation

Boilerhouse enforces strict isolation between tenants across every layer:

### Filesystem

Overlay directories are scoped per tenant. Each tenant's snapshot is stored under their tenant ID in the blob store. No tenant can read, write, or reference another tenant's overlay data.

### Network

Each instance runs with an Envoy sidecar that enforces the workload's network access policy. The sidecar only allows traffic to hosts listed in `allowed_hosts`. Credential injection is scoped to the claiming tenant's secrets.

### Secrets

Encrypted at rest with AES-256-GCM using `BOILERHOUSE_SECRET_KEY`. Scoped to the tenant ID -- there is no mechanism to share secrets across tenants.

### Containers

Each tenant gets their own container (Docker) or Pod (Kubernetes). There is no shared process space, filesystem, or network namespace between tenants.
