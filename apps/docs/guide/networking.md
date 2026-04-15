# Networking and Security

Boilerhouse provides fine-grained network access control for every workload. Outbound traffic is regulated by a combination of network access modes, domain allowlists, and an Envoy sidecar proxy that handles credential injection.

## Network Access Modes

Every workload declares a network access level in its definition:

| Mode | Outbound | Inbound | Use Case |
|---|---|---|---|
| `"none"` | Blocked | Via exposed ports only | Sandboxed execution, untrusted code |
| `"restricted"` | Allowlisted domains only | Via exposed ports | AI agents needing specific APIs |
| `"unrestricted"` | Full internet | Via exposed ports | General-purpose containers |

Set the access mode in your workload definition:

```typescript
network: {
  access: "restricted",
}
```

::: info
Regardless of the access mode, Boilerhouse always blocks access to link-local addresses (`169.254.0.0/16`) to prevent containers from reaching cloud metadata servers such as the AWS Instance Metadata Service at `169.254.169.254`.
:::

### How Access Modes Are Enforced

The enforcement mechanism depends on the runtime:

- **Docker**: containers with `"none"` access use Docker's `none` network mode (no network interface). For `"restricted"` and `"unrestricted"`, containers use `bridge` mode with an Envoy sidecar or iptables rules.
- **Kubernetes**: a per-instance `NetworkPolicy` resource controls egress. `"none"` denies all egress. `"restricted"` allows DNS and HTTPS (port 443). `"unrestricted"` allows DNS and all non-link-local traffic.

## Domain Allowlist

When `access` is `"restricted"`, outbound requests are only permitted to domains listed in the `allowlist` array:

```typescript
network: {
  access: "restricted",
  allowlist: ["api.anthropic.com", "api.openai.com", "registry.npmjs.org"],
}
```

The allowlist is enforced by the Envoy sidecar proxy, which inspects the `Host` header (HTTP) or SNI (HTTPS) of every outbound request and blocks anything not in the list.

::: warning
The Kubernetes NetworkPolicy alone cannot enforce domain-based filtering (it operates at the IP level). When using `restricted` mode on Kubernetes, the Envoy sidecar is required for domain-level enforcement. The NetworkPolicy provides defense-in-depth by limiting egress to HTTPS only.
:::

## Credential Injection

Credentials can be injected as HTTP headers for specific domains. This allows containers to call authenticated APIs without having direct access to API keys.

```typescript
network: {
  access: "restricted",
  allowlist: ["api.anthropic.com", "api.openai.com"],
  credentials: [
    {
      domain: "api.anthropic.com",
      headers: {
        "x-api-key": "${global-secret:ANTHROPIC_API_KEY}",
        "anthropic-version": "2023-06-01",
      },
    },
    {
      domain: "api.openai.com",
      headers: {
        "authorization": "Bearer ${tenant-secret:OPENAI_KEY}",
      },
    },
  ],
}
```

### Secret Resolution

Credential values support two template syntaxes:

- **`${global-secret:NAME}`** -- resolves from the server's environment variables. Use for platform-level API keys shared across all tenants.
- **`${tenant-secret:NAME}`** -- resolves from the tenant's encrypted secrets stored in Boilerhouse. Use for per-tenant credentials. Tenant secrets are set via `PUT /api/v1/tenants/:id/secrets/:name`.

Plain strings (no template syntax) are passed through as-is.

### How Injection Works

The Envoy sidecar operates as a man-in-the-middle (MITM) TLS proxy:

1. The sidecar generates a CA certificate and mounts it into the workload container
2. The workload container's `NODE_EXTRA_CA_CERTS` (and similar environment variables) are set to trust the sidecar's CA
3. When the container makes an HTTPS request, the sidecar terminates TLS, inspects the domain, injects headers if a credential rule matches, and re-encrypts for the upstream

::: tip
Credential injection is transparent to the application. No code changes are needed -- the container simply makes requests to `api.anthropic.com` and the sidecar handles authentication.
:::

### Security Considerations

- Credential domains must be in the `allowlist` when using `restricted` mode
- Tenant secrets are stored encrypted at rest using AES-256-GCM
- The MITM CA certificate is scoped to the individual instance and destroyed when the instance is released
- Global secrets are resolved at claim time and never written to disk inside the container

## Envoy Sidecar

Boilerhouse uses [Envoy Proxy](https://www.envoyproxy.io/) as a sidecar to enforce network policy and inject credentials:

- **Docker**: the sidecar runs as a separate container sharing the workload container's network namespace
- **Kubernetes**: the sidecar runs as an additional container in the same Pod, with its configuration stored in a ConfigMap

The sidecar is automatically created when:

- The workload has `network.credentials` defined, or
- The workload uses `restricted` access mode

The sidecar is not created for `"none"` access (no network to proxy) or `"unrestricted"` access without credentials (no filtering needed).

### Sidecar Resources

On Kubernetes, the Envoy sidecar is allocated:

- **CPU**: 50m request, 100m limit
- **Memory**: 32Mi request, 64Mi limit

## Port Exposure

Expose container ports to make them reachable from outside the container:

```typescript
network: {
  expose: [
    {
      guest: 8080,                   // Port inside the container
      host_range: [30000, 30099],    // Available host port range
    },
  ],
}
```

- `guest` is the port the application listens on inside the container
- `host_range` is a range of ports on the host that Boilerhouse can assign from (Docker runtime only)

On Docker, if no ports are explicitly configured and the access mode is not `"none"`, port 8080 is exposed by default.

On Kubernetes, exposed ports are mapped to a ClusterIP Service. Access from outside the cluster uses `kubectl port-forward` (development) or ingress configuration (production).

The assigned port is returned in the claim response:

```json
{
  "endpoint": {
    "host": "127.0.0.1",
    "ports": [30042]
  }
}
```

## WebSocket Support

For workloads that communicate via WebSocket (e.g., AI agents), Boilerhouse provides a WebSocket bridge at:

```
ws://localhost:3000/ws/:tenantId/:workloadName
```

This allows external clients to communicate with a tenant's running instance over a persistent WebSocket connection. The bridge handles claim resolution, health checking, and connection lifecycle.

## Related Pages

- [Runtime: Docker](./runtime-docker.md) -- Docker-specific networking details
- [Runtime: Kubernetes](./runtime-kubernetes.md) -- Kubernetes-specific networking (NetworkPolicy, port-forward)
- [Triggers](./triggers.md) -- connecting external events to instances
- [Workloads](./workloads.md) -- defining network configuration in workloads
