# Workloads

A workload is the blueprint for a containerized application or agent. It defines the image, resource limits, networking rules, health checks, idle behavior, and pooling strategy. When you register a workload, Boilerhouse builds (or pulls) the image, warms a pool of instances, and makes them available for tenant claims.

## Defining a Workload

Workloads are defined in TypeScript using the `defineWorkload()` DSL:

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "my-agent",
  version: "0.1.0",
  image: { dockerfile: "my-agent/Dockerfile" },
  resources: { vcpus: 1, memory_mb: 512 },
  network: { access: "none" },
  idle: { timeout_seconds: 300, action: "hibernate" },
  health: {
    interval_seconds: 2,
    unhealthy_threshold: 30,
    http_get: { path: "/health" },
  },
  entrypoint: { cmd: "node", args: ["server.js"] },
});
```

The sections below cover each part of the workload definition in detail.

## Image Sources

Every workload needs a container image. You specify exactly one of:

- **`image.dockerfile`** -- path to a Dockerfile, built at registration time. The path is relative to the project root.
- **`image.ref`** -- a pre-built OCI image reference (e.g., `ghcr.io/org/agent:latest`), pulled at registration time.

These two options are mutually exclusive. Provide one or the other, never both.

```typescript
// Build from Dockerfile
image: { dockerfile: "agents/my-agent/Dockerfile" }

// Use a pre-built image
image: { ref: "ghcr.io/org/my-agent:1.2.0" }
```

## Resources

Resource limits are enforced by the container runtime.

| Field       | Required | Default | Description              |
|-------------|----------|---------|--------------------------|
| `vcpus`     | Yes      | --      | Virtual CPUs (must be > 0) |
| `memory_mb` | Yes      | --      | Memory in megabytes (must be > 0) |
| `disk_gb`   | No       | 2       | Disk space in gigabytes (must be > 0) |

```typescript
resources: { vcpus: 2, memory_mb: 4096, disk_gb: 20 }
```

## Entrypoint

The entrypoint defines how the container starts.

| Field     | Required | Description                     |
|-----------|----------|---------------------------------|
| `cmd`     | Yes      | Executable to run               |
| `args`    | No       | Argument list                   |
| `env`     | No       | Key-value environment variables |
| `workdir` | No       | Working directory inside the container |

```typescript
entrypoint: {
  cmd: "node",
  args: ["server.js", "--port", "3000"],
  env: { NODE_ENV: "production", LOG_LEVEL: "info" },
  workdir: "/app",
}
```

## Filesystem Overlays

Overlay directories persist tenant state across hibernation cycles.

- **`overlay_dirs`** -- array of absolute paths to persist (e.g., `["/workspace", "/home/user"]`). These directories are snapshotted when an instance hibernates and restored when the tenant claims again.
- **`encrypt_overlays`** (default: `true`) -- encrypts overlay archives with AES-256-GCM at rest.

```typescript
overlay_dirs: ["/workspace", "/home/user/.config"],
encrypt_overlays: true,
```

See [Snapshots](./snapshots.md) for details on how overlay data is captured and restored.

## Health Checks

Health checks determine when an instance is ready to accept traffic.

| Field                    | Required | Default | Description                                      |
|--------------------------|----------|---------|--------------------------------------------------|
| `interval_seconds`       | Yes      | --      | How often to probe                               |
| `unhealthy_threshold`    | Yes      | --      | Consecutive failures before marking unhealthy     |
| `check_timeout_seconds`  | No       | 60      | Max time to wait for healthy status on startup    |

You must provide exactly one probe type:

- **`http_get`** -- sends an HTTP GET request. Fields: `path` (required), `port` (optional, defaults to the container's exposed port).
- **`exec`** -- runs a command inside the container. Field: `command` (string array). A zero exit code means healthy.

```typescript
// HTTP health check
health: {
  interval_seconds: 5,
  unhealthy_threshold: 3,
  check_timeout_seconds: 120,
  http_get: { path: "/health", port: 8080 },
}

// Exec health check
health: {
  interval_seconds: 10,
  unhealthy_threshold: 5,
  exec: { command: ["pg_isready", "-U", "postgres"] },
}
```

::: warning
`http_get` and `exec` are mutually exclusive. Providing both will cause a validation error at registration time.
:::

## Idle Policy

The idle policy controls what happens when an instance has no activity.

| Field             | Required | Description                                           |
|-------------------|----------|-------------------------------------------------------|
| `timeout_seconds` | Yes      | Seconds of inactivity before the action triggers      |
| `action`          | Yes      | `"hibernate"` or `"destroy"`                          |
| `watch_dirs`      | No       | Directories to monitor for filesystem activity        |

- **`hibernate`** -- snapshots the overlay directories, destroys the container, and restores state on the next claim. Useful for agents and development environments.
- **`destroy`** -- destroys the container with no snapshot. Suitable for stateless workloads.

```typescript
idle: {
  timeout_seconds: 600,
  action: "hibernate",
  watch_dirs: ["/workspace"],
}
```

## Pool Configuration

Pools keep pre-warmed instances ready so that claims resolve quickly.

| Field                  | Default | Description                           |
|------------------------|---------|---------------------------------------|
| `pool.size`            | 3       | Number of pre-warmed instances        |
| `pool.max_fill_concurrency` | 2  | Max parallel instance starts during fill |

```typescript
pool: { size: 5, max_fill_concurrency: 3 }
```

Setting `pool.size` to `0` disables pooling entirely -- every claim triggers a cold boot. See [Pooling](./pooling.md) for the full explanation of pool mechanics.

## Metadata

An arbitrary key-value object for your own use. Boilerhouse does not interpret this data.

```typescript
metadata: {
  description: "Customer support agent",
  team: "platform",
  tier: "production",
}
```

## Workload State Machine

A registered workload transitions through these states:

```
creating  -->  ready    (pool warmed, health checks passing)
creating  -->  error    (build failure, health check timeout)
ready     -->  creating (workload definition updated, triggers re-prime)
error     -->  creating (manual retry)
```

- **`creating`** -- the image is being built or pulled, and pool instances are warming.
- **`ready`** -- pool is warmed and instances are healthy. The workload can accept claims.
- **`error`** -- something went wrong (build failure, health check timeout). Check logs and retry.

## Example Workloads

### Minimal

A bare-bones workload: Alpine container, minimal resources, no network access, hibernates after 5 minutes of inactivity.

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "minimal",
  version: "0.1.0",
  image: { ref: "alpine:latest" },
  resources: { vcpus: 1, memory_mb: 128 },
  network: { access: "none" },
  idle: { timeout_seconds: 300, action: "hibernate" },
  entrypoint: { cmd: "sh" },
});
```

### Claude Code Agent

A full-featured coding agent: higher resource allocation, restricted network with API key injection, WebSocket support, filesystem overlays for persisting workspace state, and health checks.

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "claude-code",
  version: "0.2.0",
  image: { dockerfile: "workloads/claude-code/Dockerfile" },
  resources: { vcpus: 2, memory_mb: 4096, disk_gb: 20 },
  network: {
    access: "restricted",
    allowlist: ["api.anthropic.com"],
    expose: [{ guest: 7880, host_range: [30000, 30099] }],
    credentials: [
      {
        domain: "api.anthropic.com",
        headers: {
          "x-api-key": "${tenant-secret:ANTHROPIC_API_KEY}",
        },
      },
    ],
    websocket: "/ws",
  },
  filesystem: {
    overlay_dirs: ["/workspace", "/home/user"],
    encrypt_overlays: true,
  },
  idle: { timeout_seconds: 600, action: "hibernate", watch_dirs: ["/workspace"] },
  health: {
    interval_seconds: 2,
    unhealthy_threshold: 30,
    check_timeout_seconds: 120,
    http_get: { path: "/health" },
  },
  entrypoint: {
    cmd: "node",
    args: ["server.js"],
    env: { NODE_ENV: "production" },
    workdir: "/app",
  },
  pool: { size: 5, max_fill_concurrency: 3 },
  metadata: { description: "Claude Code sandboxed agent" },
});
```

This workload uses [per-tenant secrets](./tenants.md) to inject API keys into outbound requests via the Envoy sidecar. The `${tenant-secret:ANTHROPIC_API_KEY}` placeholder is resolved at claim time from the tenant's encrypted secret store.
