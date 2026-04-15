# Workload Schema

Complete reference for the workload configuration object used with `defineWorkload()` and the `POST /api/v1/workloads` endpoint.

## `defineWorkload(config)`

TypeScript function that validates and returns a workload configuration object. Workload definitions are typically stored as files in the workloads directory.

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "my-agent",
  version: "0.1.0",
  image: { ref: "ghcr.io/org/my-agent:latest" },
  resources: { vcpus: 1, memory_mb: 512 },
  network: {
    access: "restricted",
    allowlist: ["api.openai.com"],
    expose: [{ guest: 8080, host_range: [30000, 31000] }],
  },
  entrypoint: { cmd: "node", args: ["server.js"] },
  health: {
    interval_seconds: 10,
    unhealthy_threshold: 3,
    http_get: { path: "/health", port: 8080 },
  },
  idle: { timeout_seconds: 300, action: "hibernate" },
  pool: { size: 5 },
});
```

---

## Fields

### `name`

- **Type:** `string`
- **Required:** yes
- **Pattern:** `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`

Unique identifier for the workload. Used in API paths and tenant claims. Must start with an alphanumeric character and contain only alphanumerics, dots, hyphens, and underscores.

### `version`

- **Type:** `string`
- **Required:** yes
- **Minimum length:** 1

Version string for the workload. Changing the version triggers a workload update, which rebuilds the image (if using a Dockerfile) and rolls the pool.

### `image`

Container image configuration. Exactly one of `ref` or `dockerfile` must be provided.

#### `image.ref`

- **Type:** `string`

OCI image reference to pull from a registry.

```typescript
image: { ref: "ghcr.io/org/my-agent:0.1.0" }
```

#### `image.dockerfile`

- **Type:** `string`

Path to a Dockerfile, relative to the workloads directory. Boilerhouse builds the image on workload creation and version updates.

```typescript
image: { dockerfile: "./my-agent/Dockerfile" }
```

### `resources`

Resource limits for each instance.

#### `resources.vcpus`

- **Type:** `number`
- **Required:** yes
- **Constraint:** must be > 0

Number of virtual CPUs allocated to each instance. Fractional values are supported (e.g., `0.5`).

#### `resources.memory_mb`

- **Type:** `number`
- **Required:** yes
- **Constraint:** must be > 0

Memory limit in megabytes.

#### `resources.disk_gb`

- **Type:** `number`
- **Default:** `2`
- **Constraint:** must be > 0

Disk space limit in gigabytes.

### `network`

Network access and port configuration.

#### `network.access`

- **Type:** `"none" | "restricted" | "unrestricted"`
- **Default:** `"none"`

Controls outbound network access from the container:

| Value | Behavior |
|-------|----------|
| `none` | No outbound network access (default) |
| `restricted` | Outbound only to domains listed in `allowlist` |
| `unrestricted` | Full outbound network access |

#### `network.allowlist`

- **Type:** `string[]`

Domain allowlist for `restricted` mode. Each entry is a domain name (e.g., `"api.openai.com"`). Ignored when access is `none` or `unrestricted`.

```typescript
network: {
  access: "restricted",
  allowlist: ["api.openai.com", "api.anthropic.com"],
}
```

#### `network.expose`

- **Type:** `Array<{ guest: number, host_range: [number, number] }>`

Port mappings from the container to the host. Each entry maps a container port (`guest`) to a host port range. Boilerhouse allocates an available port within the range for each instance.

```typescript
network: {
  expose: [
    { guest: 8080, host_range: [30000, 31000] },
    { guest: 3000, host_range: [31000, 32000] },
  ],
}
```

#### `network.credentials`

- **Type:** `Array<{ domain: string, headers: Record<string, string> }>`

Header injection rules applied per domain by the network sidecar. Supports secret references using `${global-secret:NAME}` and `${tenant-secret:NAME}` template syntax.

```typescript
network: {
  access: "restricted",
  allowlist: ["api.openai.com"],
  credentials: [
    {
      domain: "api.openai.com",
      headers: {
        "Authorization": "Bearer ${tenant-secret:OPENAI_API_KEY}",
      },
    },
  ],
}
```

::: info
When `network.access` is `"restricted"`, each credential domain must also appear in the `allowlist`. Credentials cannot be used when access is `"none"`.
:::

#### `network.websocket`

- **Type:** `string`

WebSocket path inside the container. When set, the claim response includes a `websocket` field and Boilerhouse proxies WebSocket connections to this path.

```typescript
network: { websocket: "/ws" }
```

### `filesystem`

Filesystem persistence configuration.

#### `filesystem.overlay_dirs`

- **Type:** `string[]`

Directories inside the container that are persisted across hibernation cycles. These directories are captured as overlays when an instance hibernates and restored when the tenant reclaims.

```typescript
filesystem: {
  overlay_dirs: ["/home/user/workspace", "/var/data"],
}
```

#### `filesystem.encrypt_overlays`

- **Type:** `boolean`
- **Default:** `true`

Whether to encrypt overlay data at rest using AES-256-GCM with the `BOILERHOUSE_SECRET_KEY`.

### `idle`

Idle timeout configuration. Controls what happens when an instance has no activity.

#### `idle.timeout_seconds`

- **Type:** `number`
- **Constraint:** must be > 0

Seconds of inactivity before the idle action is triggered. Activity is detected via network traffic, filesystem writes (in `watch_dirs`), and API interactions.

#### `idle.action`

- **Type:** `"hibernate" | "destroy"`
- **Default:** `"hibernate"`

Action to take when the idle timeout expires:

| Value | Behavior |
|-------|----------|
| `hibernate` | Snapshot the instance and stop it. State is restored on next claim. |
| `destroy` | Permanently destroy the instance. No state is preserved. |

#### `idle.watch_dirs`

- **Type:** `string[]`

Additional directories to monitor for write activity. Writes to these directories reset the idle timer.

### `health`

Health check configuration. When present, Boilerhouse monitors instance health and marks unhealthy instances for replacement.

#### `health.interval_seconds`

- **Type:** `number`
- **Required:** yes (when `health` block is present)
- **Constraint:** must be > 0

Interval in seconds between health checks.

#### `health.unhealthy_threshold`

- **Type:** `number`
- **Required:** yes (when `health` block is present)
- **Constraint:** must be > 0

Number of consecutive failed checks before an instance is marked unhealthy.

#### `health.check_timeout_seconds`

- **Type:** `number`
- **Default:** `60`

Maximum time in seconds to wait for a healthy status on startup. If the instance does not become healthy within this window, it is marked as failed.

#### `health.http_get`

- **Type:** `{ path: string, port?: number }`

HTTP health check. Boilerhouse sends a GET request to the specified path. A 2xx response is considered healthy.

```typescript
health: {
  interval_seconds: 10,
  unhealthy_threshold: 3,
  http_get: { path: "/health", port: 8080 },
}
```

::: warning
Mutually exclusive with `health.exec`. Specify one or the other, not both.
:::

#### `health.exec`

- **Type:** `{ command: string[] }`

Command-based health check. The command is executed inside the container. Exit code 0 is considered healthy. Each element of the command array must be non-empty.

```typescript
health: {
  interval_seconds: 15,
  unhealthy_threshold: 2,
  exec: { command: ["curl", "-sf", "http://localhost:8080/health"] },
}
```

::: warning
Mutually exclusive with `health.http_get`. Specify one or the other, not both.
:::

### `entrypoint`

Container entrypoint configuration.

#### `entrypoint.cmd`

- **Type:** `string`
- **Required:** yes

The command to run inside the container.

#### `entrypoint.args`

- **Type:** `string[]`

Arguments passed to the command.

```typescript
entrypoint: { cmd: "node", args: ["server.js", "--port", "8080"] }
```

#### `entrypoint.env`

- **Type:** `Record<string, string>`

Environment variables injected into the container.

```typescript
entrypoint: {
  cmd: "python",
  args: ["app.py"],
  env: { NODE_ENV: "production", LOG_LEVEL: "info" },
}
```

#### `entrypoint.workdir`

- **Type:** `string`

Working directory for the entrypoint command inside the container.

### `pool`

Instance pool configuration. Pools keep warm instances ready so that tenant claims are served immediately without waiting for container startup.

#### `pool.size`

- **Type:** `number`
- **Default:** `3`
- **Minimum:** `0`

Number of warm instances to maintain in the pool. Set to `0` to disable pooling entirely (instances are created on demand).

#### `pool.max_fill_concurrency`

- **Type:** `number`
- **Default:** `2`
- **Constraint:** must be > 0

Maximum number of instances that can be started concurrently when filling the pool.

### `metadata`

- **Type:** `Record<string, unknown>`

Arbitrary key-value metadata attached to the workload. Not used by Boilerhouse internally but available via the API for external tooling.

```typescript
metadata: {
  team: "platform",
  tier: "production",
  description: "Customer-facing coding assistant",
}
```
