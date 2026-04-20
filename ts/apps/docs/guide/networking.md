# Networking & Security

Boilerhouse provides fine-grained control over container network access, from full isolation to restricted internet access with credential injection.

## Network Access Modes

Every workload declares its network access level:

```yaml
network:
  access: none | restricted | unrestricted
```

The operator translates this into a `NetworkPolicy` attached to the Pod.

### `none`

The Pod has no network egress at all. No outbound connections, no DNS resolution, no exposed ports.

```yaml
network:
  access: none
```

The operator generates a NetworkPolicy that denies all egress from the Pod.

Use for: sandboxed code execution, untrusted workloads, workloads that only need local filesystem access.

### `unrestricted`

The Pod has full outbound internet access. Cloud metadata endpoints (169.254.0.0/16) are blocked to prevent credential leakage.

```yaml
network:
  access: unrestricted
```

The NetworkPolicy allows all egress except link-local addresses.

Use for: workloads that need broad internet access and you trust the code running inside.

### `restricted`

The Pod can only reach domains on the allowlist. DNS and HTTPS are allowed at the NetworkPolicy layer, and an Envoy sidecar (when credential injection is configured) enforces domain-level filtering and header injection.

```yaml
network:
  access: restricted
  allowlist:
    - api.anthropic.com
    - registry.npmjs.org
    - github.com
```

Use for: AI agents, sandboxed environments where you want controlled internet access.

## Domain Allowlist

The allowlist specifies which domains the container can reach:

```yaml
allowlist:
  - api.anthropic.com
  - "*.github.com"          # wildcard subdomains
  - registry.npmjs.org
```

When the Envoy sidecar is present (i.e., the workload has `credentials`), it intercepts all outbound HTTPS traffic and only forwards requests to allowed domains. Requests to non-allowed domains are rejected.

DNS resolution is always allowed (port 53) so the container can resolve hostnames.

## Credential Injection

Inject API keys and authentication headers into outbound requests without exposing them to the container:

```yaml
network:
  access: restricted
  allowlist:
    - api.anthropic.com
  credentials:
    - domain: api.anthropic.com
      headers:
        - name: x-api-key
          valueFrom:
            secretKeyRef:
              name: anthropic-api
              key: key
```

Create the referenced Secret in the operator's namespace:

```bash
kubectl -n boilerhouse create secret generic anthropic-api \
  --from-literal=key="sk-ant-..."
```

### How It Works

1. The operator generates a self-signed CA certificate per workload
2. For each credential domain, a leaf TLS certificate is generated and stored in a ConfigMap
3. Envoy (running as a sidecar in the Pod) acts as a MITM TLS proxy for those domains
4. The operator injects the CA into the container's trust store and sets `https_proxy`
5. Outbound HTTPS requests to `api.anthropic.com` are intercepted
6. The `x-api-key` header is injected into the request
7. The request is forwarded to the real destination

The container never sees the key — it sees `http://api.anthropic.com` routed through the sidecar, and the sidecar holds the real credential.

### Inline Values

For non-secret headers, use `value` directly instead of `valueFrom`:

```yaml
credentials:
  - domain: api.example.com
    headers:
      - name: x-client-id
        value: public-client-id
      - name: x-api-key
        valueFrom:
          secretKeyRef:
            name: example-api
            key: secret
```

## Port Exposure

Expose container ports so claims can return an endpoint:

```yaml
network:
  access: restricted
  expose:
    - guest: 8080
```

`guest` is the port inside the container. The operator creates a `ClusterIP` Service routing to the Pod. Claim responses include the Service address:

```json
{
  "endpoint": { "host": "10.244.0.12", "port": 8080 }
}
```

For external access, add a `LoadBalancer` or `Ingress` in front of the Service, or use `kubectl port-forward` for local development:

```bash
kubectl port-forward -n boilerhouse svc/<service-name> 8080:8080
```

## Envoy Sidecar

The Envoy sidecar is the enforcement mechanism for credential injection on `restricted` workloads.

### What It Does

- Intercepts all outbound HTTP/HTTPS traffic from the container
- Filters requests against the domain allowlist
- Performs MITM TLS termination for credential injection domains
- Injects configured headers into matching requests

### When It's Added

The sidecar is injected into the Pod when the workload has `credentials` configured. For `restricted` access without credentials, the NetworkPolicy alone enforces filtering (at the port/host level, not per-domain).

### TLS Certificates

The operator generates:
- A self-signed CA certificate per workload (EC prime256v1)
- Per-domain leaf certificates signed by the CA
- Certificates are stored in a ConfigMap mounted into the sidecar

The CA certificate is projected into the container's trust store via `/etc/ssl/certs` so the container trusts the sidecar's certificates.

## Container Security

Beyond network isolation, the operator applies a hardened Pod security context:

### Linux Capabilities

All capabilities are dropped by default:

```yaml
securityContext:
  capabilities:
    drop: [ALL]
```

No capabilities are re-added unless required by the workload.

### Privilege Escalation

- `allowPrivilegeEscalation: false` prevents setuid/setgid binaries from gaining elevated privileges
- `runAsNonRoot: true` is applied when the image supports it

### Resource Limits

`resources.vcpus`, `resources.memoryMb`, and `resources.diskGb` are enforced as Pod resource requests/limits. Pods cannot exceed their declared resource allocation.

### Metadata Server Blocking

Cloud metadata endpoints (169.254.0.0/16) are blocked by the generated NetworkPolicy for all access modes except `none` (which blocks everything anyway). This prevents Pods from accessing cloud instance credentials on AWS, GCP, or Azure nodes.
