# Tenants & Claims

Boilerhouse is multi-tenant by design. Every running Pod is associated with a tenant, and tenants interact with instances through the **claim** system.

## What is a Tenant?

A tenant is an identity — a user, an organization, or any entity that needs its own isolated container. Tenant IDs are free-form strings that can be anything printable:

- `user-123` — internal user ID
- `tg-jane` — Telegram username from a trigger
- `org:acme` — organization identifier

Tenant IDs must be valid Kubernetes label values (`[a-z0-9A-Z._-]`, max 63 chars) because they end up as `boilerhouse.dev/tenant` labels on Pods and Claims.

## Claims

A `BoilerhouseClaim` is a tenant's active lease on an instance. A tenant can have one claim per workload at a time; the claim's name is derived as `claim-<tenantId>-<workloadRef>`.

### Claiming

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/claim \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

When a tenant claims, the operator picks the fastest available path:

1. **Existing** — an active claim already exists for this (tenant, workload). Returns immediately.
2. **Pool** — a pre-warmed Pod is available. Acquired from the pool.
3. **Pool+data** — pool Pod with the tenant's previous overlay injected.
4. **Cold** — no pool available. A new Pod is created from scratch.
5. **Cold+data** — cold boot with the tenant's previous overlay restored.

The claim response includes a `source` field so you know which path was taken:

```json
{
  "tenantId": "alice",
  "phase": "Active",
  "instanceId": "inst-alice-my-agent-a1b2c3",
  "endpoint": { "host": "10.244.0.12", "port": 8080 },
  "source": "pool+data",
  "claimedAt": "2026-04-20T10:30:00Z"
}
```

### Claiming via kubectl

The REST API is the ergonomic path, but you can create a claim directly with `kubectl`:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseClaim
metadata:
  name: claim-alice-my-agent
  namespace: boilerhouse
  labels:
    boilerhouse.dev/tenant: alice
spec:
  tenantId: alice
  workloadRef: my-agent
  resume: true
```

Set `resume: true` to restore the tenant's previous overlay if one exists.

### Releasing

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/release \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

Or delete the claim directly:

```bash
kubectl delete boilerhouseclaim claim-alice-my-agent -n boilerhouse
```

Release extracts the tenant's overlay data and either hibernates or destroys the Pod (depending on the workload's `idle.action` setting).

### Idle Release

If the workload has an idle timeout configured, the operator automatically releases the claim when the timeout fires. No manual release call is needed.

### Claim Phases

```
Pending ──► Active ──► Releasing ──► Released
                │
                └──► Error / ReleaseFailed
```

See [State Machines](../reference/state-machines) for full details.

## Tenant State

Query a tenant's current claims across all workloads:

```bash
curl http://localhost:3000/api/v1/tenants/alice
```

```json
{
  "tenantId": "alice",
  "claims": [
    {
      "tenantId": "alice",
      "phase": "Active",
      "instanceId": "inst-alice-my-agent-a1b2c3",
      "endpoint": { "host": "10.244.0.12", "port": 8080 },
      "source": "pool",
      "claimedAt": "2026-04-20T10:30:00Z"
    }
  ]
}
```

A tenant can have entries for multiple workloads — for example, one claim on `claude-code` and another on `openclaw`.

List all tenants:

```bash
curl http://localhost:3000/api/v1/tenants
```

## Secrets

Credential injection uses Kubernetes `Secret` resources in the operator's namespace, referenced from the workload spec:

```yaml
network:
  credentials:
    - domain: api.anthropic.com
      headers:
        - name: x-api-key
          valueFrom:
            secretKeyRef:
              name: anthropic-api
              key: key
```

Create the Secret with `kubectl`:

```bash
kubectl -n boilerhouse create secret generic anthropic-api \
  --from-literal=key="sk-ant-..."
```

For per-tenant secrets, create one Secret per tenant and template the `secretKeyRef.name` into a tenant-specific workload variant. A first-class per-tenant secret store is on the roadmap but not yet in the Go implementation.

## Data Isolation

Boilerhouse provides several layers of tenant isolation:

### Filesystem Isolation

Each tenant's data is stored in separate overlay archives under `/snapshots/<tenantId>/<workload>.tar.gz` on the snapshots PVC. Overlay directories declared in the workload config (`filesystem.overlayDirs`) are extracted and stored per-tenant. One tenant cannot access another tenant's overlay data.

### Network Isolation

Each Pod runs with its own network namespace. The operator generates a `NetworkPolicy` per workload based on `network.access`:
- `none` — deny all egress
- `restricted` — DNS + HTTPS only (the Envoy sidecar enforces the domain allowlist when configured)
- `unrestricted` — all egress except link-local (169.254.0.0/16)

### Credential Scoping

Credentials injected via `network.credentials` are applied per-Pod by the Envoy sidecar. The sidecar injects headers only for the specified domains, and only for Pods where the sidecar is running.

### Container Security

The translator applies a hardened security context to every managed Pod:
- All Linux capabilities dropped
- `allowPrivilegeEscalation: false`
- `runAsNonRoot: true` when the image supports it
- Cloud metadata endpoints (169.254.0.0/16) blocked via NetworkPolicy
