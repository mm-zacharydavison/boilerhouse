# Workloads

A workload is the central configuration unit in Boilerhouse. It defines everything about a container: what image to run, how much CPU and memory to allocate, what network access it gets, when to hibernate, and how to check its health.

## Defining a Workload

Workloads are defined using the `defineWorkload()` function from `@boilerhouse/core`:

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "my-agent",
  version: "1.0.0",
  image: { ref: "my-registry/my-agent:latest" },
  resources: { vcpus: 2, memory_mb: 2048 },
  network: { access: "none" },
  idle: { timeout_seconds: 300, action: "hibernate" },
});
```

Every workload needs a `name` and `version`. The name is used in API calls (`POST /tenants/:id/claim` with `{"workload": "my-agent"}`), and the version tracks configuration changes.

## Image Sources

Boilerhouse supports two image sources:

### Pre-built Image

Reference an image from a registry:

```typescript
image: { ref: "alpine:latest" }
image: { ref: "ghcr.io/myorg/my-agent:v2" }
```

### Dockerfile

Build from a Dockerfile relative to the workloads directory:

```typescript
image: { dockerfile: "my-agent/Dockerfile" }
```

The Docker runtime builds the image locally. The Kubernetes runtime requires pre-built images pushed to a registry (or uses minikube's local image cache for development).

## Resources

Every workload declares its resource requirements:

```typescript
resources: {
  vcpus: 2,        // CPU cores
  memory_mb: 4096, // Memory in megabytes
  disk_gb: 20,     // Disk space in gigabytes (default: 2)
}
```

These map directly to container resource limits — Docker resource constraints or Kubernetes Pod resource limits/requests.

## Entrypoint

Override the container's default entrypoint:

```typescript
entrypoint: {
  cmd: "node",
  args: ["server.js"],
  workdir: "/app",
  env: {
    NODE_ENV: "production",
    PORT: "8080",
  },
}
```

Environment variables set here are baked into the container at creation time.

## Network Access

Control what network access the container gets:

```typescript
// No network at all
network: { access: "none" }

// Full internet access
network: { access: "unrestricted" }

// Restricted to specific domains
network: {
  access: "restricted",
  allowlist: ["api.openai.com", "registry.npmjs.org"],
}
```

For restricted access, an Envoy sidecar proxy enforces the allowlist. See [Networking & Security](./networking) for details.

### Exposing Ports

Expose container ports to the host:

```typescript
network: {
  access: "restricted",
  expose: [{ guest: 8080, host_range: [30000, 30099] }],
}
```

`guest` is the port inside the container. `host_range` defines the port range on the host. Boilerhouse picks an available port in that range.

### WebSocket Path

If your workload speaks WebSocket, declare the path:

```typescript
network: {
  access: "restricted",
  expose: [{ guest: 7880, host_range: [30000, 30099] }],
  websocket: "/ws",
}
```

The `websocket` path is returned in claim responses so clients know where to connect.

### Credential Injection

Inject API keys into outbound requests via the Envoy sidecar:

```typescript
import { secret } from "@boilerhouse/core";

network: {
  access: "restricted",
  allowlist: ["api.anthropic.com"],
  credentials: [{
    domain: "api.anthropic.com",
    headers: { "x-api-key": secret("ANTHROPIC_API_KEY") },
  }],
}
```

The `secret()` function references a secret stored in Boilerhouse's secret store. The Envoy proxy intercepts HTTPS requests to the specified domain and injects the headers via MITM TLS interception.

## Filesystem Overlays

Declare directories whose contents should be persisted across hibernation cycles:

```typescript
filesystem: {
  overlay_dirs: ["/workspace", "/home/user"],
  encrypt_overlays: true, // default: true
}
```

When a tenant's instance is released or hibernated, Boilerhouse extracts these directories as a tar archive and stores them in the blob store. On the next claim, the archive is injected back into a fresh container.

## Health Checks

Define how Boilerhouse determines when a container is ready:

### HTTP Health Check

```typescript
health: {
  interval_seconds: 5,
  unhealthy_threshold: 10,
  http_get: { path: "/health", port: 8080 },
}
```

Polls the HTTP endpoint at the given interval. The instance is considered healthy after the first successful response (2xx status). It's considered unhealthy after `unhealthy_threshold` consecutive failures.

### Exec Health Check

```typescript
health: {
  interval_seconds: 5,
  unhealthy_threshold: 10,
  exec: { command: ["pg_isready"] },
}
```

Runs a command inside the container. Exit code 0 means healthy.

### Check Timeout

```typescript
health: {
  interval_seconds: 5,
  unhealthy_threshold: 30,
  check_timeout_seconds: 120, // default: 60
  http_get: { path: "/health", port: 8080 },
}
```

`check_timeout_seconds` is the total time to wait for the container to become healthy before giving up.

## Idle Policy

Control what happens when a container goes idle:

```typescript
idle: {
  timeout_seconds: 300,   // 5 minutes
  action: "hibernate",    // or "destroy"
}
```

- `hibernate` — extracts overlay, destroys container, saves state for later restoration
- `destroy` — destroys container and discards state

### Watch Directories

For workloads where filesystem activity indicates usage (e.g., coding agents), add watch directories:

```typescript
idle: {
  timeout_seconds: 60,
  action: "hibernate",
  watch_dirs: ["/root/.openclaw"],
}
```

Boilerhouse periodically checks these directories for modification time changes. If files change, the idle timer resets.

## Pool Configuration

Pre-warm instances for fast claims:

```typescript
pool: {
  size: 3,                  // number of warm instances to maintain
  max_fill_concurrency: 2,  // max parallel instance creations
}
```

See [Pooling](./pooling) for details.

## Metadata

Attach arbitrary metadata to a workload:

```typescript
metadata: {
  description: "Claude Code agent container",
  homepage: "https://claude.ai",
  connect_url: "http://{{host}}:{{port}}/",
}
```

Metadata is stored with the workload and returned in API responses.

## Example Workloads

### Minimal (Testing)

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "minimal",
  version: "0.1.0",
  image: { dockerfile: "minimal/Dockerfile" },
  resources: { vcpus: 1, memory_mb: 128 },
  network: { access: "none" },
  idle: { timeout_seconds: 300, action: "hibernate" },
  metadata: { description: "Minimal Alpine VM for testing" },
});
```

### Claude Code (AI Agent)

```typescript
import { defineWorkload, secret } from "@boilerhouse/core";

export default defineWorkload({
  name: "claude-code",
  version: "2026.3.26d",
  image: { dockerfile: "claude-code/Dockerfile" },
  resources: { vcpus: 2, memory_mb: 4096, disk_gb: 20 },
  network: {
    access: "restricted",
    allowlist: [
      "api.anthropic.com",
      "statsig.anthropic.com",
      "sentry.io",
      "registry.npmjs.org",
      "github.com",
      "api.github.com",
    ],
    expose: [{ guest: 7880, host_range: [30000, 30099] }],
    websocket: "/ws",
    credentials: [{
      domain: "api.anthropic.com",
      headers: { "x-api-key": secret("ANTHROPIC_API_KEY") },
    }],
  },
  filesystem: { overlay_dirs: ["/workspace", "/home/claude"] },
  idle: { timeout_seconds: 300, action: "hibernate" },
  health: {
    interval_seconds: 2,
    unhealthy_threshold: 30,
    http_get: { path: "/health", port: 7880 },
  },
  entrypoint: {
    cmd: "node",
    args: ["bridge.mjs"],
    workdir: "/app",
    env: {
      ANTHROPIC_API_KEY: "sk-ant-proxy-managed",
      ANTHROPIC_BASE_URL: "http://api.anthropic.com",
      CLAUDE_MODEL: "sonnet",
    },
  },
  metadata: {
    description: "Claude Code agent",
    homepage: "https://claude.ai",
  },
});
```

### HTTP Server (Demo)

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "httpserver",
  version: "0.1.0",
  image: { dockerfile: "httpserver/Dockerfile" },
  resources: { vcpus: 1, memory_mb: 256 },
  network: {
    access: "unrestricted",
    expose: [{ guest: 8080, host_range: [30100, 30199] }],
  },
  idle: { timeout_seconds: 120, action: "destroy" },
  health: {
    interval_seconds: 2,
    unhealthy_threshold: 15,
    http_get: { path: "/", port: 8080 },
  },
  metadata: { description: "Simple HTTP server for testing" },
});
```

## Full Schema Reference

See [Workload Schema Reference](../reference/workload-schema) for the complete typed schema with all fields and their defaults.
