# Networking & Security

Boilerhouse provides fine-grained control over container network access, from full isolation to restricted internet access with credential injection.

## Network Access Modes

Every workload declares its network access level:

```typescript
network: {
  access: "none" | "unrestricted" | "restricted"
}
```

### `none`

The container has no network access at all. No outbound connections, no DNS resolution, no exposed ports.

```typescript
network: { access: "none" }
```

**Docker:** Container runs with `NetworkMode: "none"`.  
**Kubernetes:** A NetworkPolicy denies all egress.

Use for: sandboxed code execution, untrusted workloads, workloads that only need local filesystem access.

### `unrestricted`

The container has full outbound internet access. Cloud metadata endpoints (169.254.0.0/16) are blocked to prevent credential leakage.

```typescript
network: { access: "unrestricted" }
```

**Docker:** Bridge network with iptables blocking metadata.  
**Kubernetes:** NetworkPolicy allows all egress except link-local addresses.

Use for: workloads that need broad internet access and you trust the code running inside.

### `restricted`

The container can only reach domains on the allowlist. All other outbound traffic is blocked. An Envoy sidecar proxy enforces the restrictions.

```typescript
network: {
  access: "restricted",
  allowlist: [
    "api.anthropic.com",
    "registry.npmjs.org",
    "github.com",
  ],
}
```

**Docker:** Bridge network + Envoy sidecar container + iptables redirect.  
**Kubernetes:** NetworkPolicy allows only DNS + HTTPS. Envoy sidecar in the Pod enforces domain-level filtering.

Use for: AI agents, sandboxed environments where you want controlled internet access.

## Domain Allowlist

The allowlist specifies which domains the container can reach:

```typescript
allowlist: [
  "api.anthropic.com",
  "*.github.com",        // wildcard subdomains
  "registry.npmjs.org",
]
```

The Envoy sidecar intercepts all outbound HTTPS traffic and only forwards requests to allowed domains. Requests to non-allowed domains are rejected.

DNS resolution is allowed (port 53) so the container can resolve hostnames.

## Credential Injection

Inject API keys and authentication headers into outbound requests without exposing them to the container:

```typescript
import { secret } from "@boilerhouse/core";

network: {
  access: "restricted",
  allowlist: ["api.anthropic.com"],
  credentials: [{
    domain: "api.anthropic.com",
    headers: {
      "x-api-key": secret("ANTHROPIC_API_KEY"),
    },
  }],
}
```

### How It Works

1. The Envoy sidecar generates a self-signed CA certificate
2. For each credential domain, a leaf TLS certificate is generated
3. The sidecar acts as a MITM TLS proxy for those domains
4. Outbound HTTPS requests to `api.anthropic.com` are intercepted
5. The `x-api-key` header is injected into the request
6. The request is forwarded to the real destination

The container sees `http://api.anthropic.com` (the sidecar handles TLS) and the API key is never exposed inside the container.

### Secret References

The `secret()` function references a secret stored in Boilerhouse:

```typescript
// In the workload definition
headers: { "x-api-key": secret("ANTHROPIC_API_KEY") }
```

Store the actual secret value via the API:

```bash
curl -X PUT http://localhost:3000/api/v1/tenants/alice/secrets/ANTHROPIC_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-ant-..."}'
```

Per-tenant secrets allow each tenant to use their own API key with the same workload definition.

## Port Exposure

Expose container ports to the outside:

```typescript
network: {
  access: "restricted",
  expose: [{
    guest: 8080,
    host_range: [30000, 30099],
  }],
}
```

| Field | Description |
|-------|-------------|
| `guest` | Port inside the container |
| `host_range` | `[min, max]` range for the host port. Boilerhouse picks an available port. |

The mapped port is returned in the claim response:

```json
{
  "endpoint": { "host": "127.0.0.1", "ports": [30042] }
}
```

On Kubernetes, exposed ports create a ClusterIP Service. For minikube development, `kubectl port-forward` maps the port to localhost.

## Envoy Sidecar

The Envoy sidecar is the enforcement mechanism for `restricted` network access and credential injection.

### What It Does

- Intercepts all outbound HTTP/HTTPS traffic from the container
- Filters requests against the domain allowlist
- Performs MITM TLS termination for credential injection domains
- Injects configured headers into matching requests
- Logs all proxied requests

### When It's Used

The sidecar is added automatically when:
- `network.access` is `"restricted"` AND the workload has `credentials`, OR
- the workload needs domain-level filtering with credential injection

For `restricted` access without credentials, NetworkPolicies (K8s) or iptables rules (Docker) handle the filtering without a sidecar.

### TLS Certificates

The sidecar generates:
- A self-signed CA certificate (EC prime256v1)
- Per-domain leaf certificates signed by the CA
- Certificates are stored in a ConfigMap (K8s) or temp directory (Docker)

The CA certificate is injected into the container's trust store so the container trusts the sidecar's certificates.

## Container Security

Beyond network isolation, Boilerhouse applies defense-in-depth security:

### Linux Capabilities

All capabilities are dropped by default:

```
CAP_DROP: ALL
```

No capabilities are re-added unless required by the workload.

### Seccomp Profiles

Apply a custom seccomp profile to restrict system calls:

```bash
export SECCOMP_PROFILE_PATH=/path/to/seccomp.json
```

### Privilege Escalation

- `no_new_privileges: true` prevents setuid/setgid binaries from gaining elevated privileges
- `allowPrivilegeEscalation: false` (Kubernetes)
- `readOnlyRootFilesystem: true` (Kubernetes) — only overlay directories are writable

### Resource Limits

CPU, memory, and disk limits are enforced at the runtime level. Containers cannot exceed their declared resource allocation.

### Metadata Server Blocking

Cloud metadata endpoints (169.254.0.0/16) are blocked for all containers with network access. This prevents containers from accessing cloud instance credentials on AWS, GCP, or Azure hosts.
