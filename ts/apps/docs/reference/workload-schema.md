# Workload Schema Reference

Complete reference for the workload definition object passed to `defineWorkload()` or `POST /api/v1/workloads`.

## Top-Level Structure

```typescript
defineWorkload({
  name: string,          // required
  version: string,       // required
  image: ImageConfig,    // required
  resources: Resources,  // required
  network: Network,      // required
  idle: IdleConfig,      // required
  filesystem?: Filesystem,
  health?: HealthCheck,
  entrypoint?: Entrypoint,
  pool?: PoolConfig,
  metadata?: Record<string, unknown>,
})
```

When submitting via the API, the top-level object wraps these fields:

```json
{
  "workload": { "name": "...", "version": "..." },
  "image": { ... },
  "resources": { ... },
  "network": { ... },
  "idle": { ... }
}
```

---

## `name`

- **Type:** `string`
- **Required:** yes

The workload name. Used in API calls to identify the workload (e.g., `{"workload": "my-agent"}` in claim requests). Must be unique across all registered workloads.

## `version`

- **Type:** `string`
- **Required:** yes

The workload version. Used for tracking configuration changes. A workload with the same name and version cannot be registered twice.

---

## `image`

- **Type:** `{ ref: string }` or `{ dockerfile: string }`
- **Required:** yes (exactly one of `ref` or `dockerfile`)

### `image.ref`

OCI image reference from a container registry:

```typescript
image: { ref: "alpine:latest" }
image: { ref: "ghcr.io/myorg/my-agent:v2.1.0" }
```

### `image.dockerfile`

Path to a Dockerfile, relative to the workloads directory:

```typescript
image: { dockerfile: "my-agent/Dockerfile" }
```

The Docker runtime builds the image locally. Kubernetes requires pre-built images (except with minikube, which builds locally).

---

## `resources`

- **Type:** `{ vcpus: number, memory_mb: number, disk_gb?: number }`
- **Required:** yes

### `resources.vcpus`

- **Type:** `number`
- **Required:** yes

CPU cores allocated to the container.

### `resources.memory_mb`

- **Type:** `number`
- **Required:** yes

Memory in megabytes.

### `resources.disk_gb`

- **Type:** `number`
- **Default:** `2`

Disk space in gigabytes.

---

## `network`

- **Type:** `object`
- **Required:** yes

### `network.access`

- **Type:** `"none" | "unrestricted" | "restricted"`
- **Required:** yes

| Value | Description |
|-------|-------------|
| `none` | No network access. No DNS, no outbound, no exposed ports. |
| `unrestricted` | Full internet access. Cloud metadata endpoints blocked. |
| `restricted` | Only allowed domains. Enforced by Envoy sidecar. |

### `network.allowlist`

- **Type:** `string[]`
- **Required:** no (only used with `restricted`)

Domains the container is allowed to reach:

```typescript
allowlist: ["api.anthropic.com", "*.github.com"]
```

### `network.expose`

- **Type:** `Array<{ guest: number, host_range: [number, number] }>`
- **Required:** no

Expose container ports to the host.

| Field | Type | Description |
|-------|------|-------------|
| `guest` | `number` | Port inside the container |
| `host_range` | `[number, number]` | Min and max host port range |

### `network.websocket`

- **Type:** `string`
- **Required:** no

WebSocket path. Returned in claim responses so clients know where to connect:

```typescript
websocket: "/ws"
```

### `network.credentials`

- **Type:** `Array<{ domain: string, headers: Record<string, string | SecretRef> }>`
- **Required:** no

Inject HTTP headers into outbound requests for specific domains:

```typescript
import { secret } from "@boilerhouse/core";

credentials: [{
  domain: "api.anthropic.com",
  headers: {
    "x-api-key": secret("ANTHROPIC_API_KEY"),
    "x-custom": "static-value",
  },
}]
```

`secret("NAME")` references a secret in the Boilerhouse secret store. Static strings are also supported.

---

## `filesystem`

- **Type:** `object`
- **Required:** no

### `filesystem.overlay_dirs`

- **Type:** `string[]`
- **Required:** no

Directories to persist across hibernation cycles:

```typescript
overlay_dirs: ["/workspace", "/home/user"]
```

### `filesystem.encrypt_overlays`

- **Type:** `boolean`
- **Default:** `true`

Encrypt overlay archives at rest using AES-256-GCM.

---

## `idle`

- **Type:** `object`
- **Required:** yes

### `idle.timeout_seconds`

- **Type:** `number`
- **Required:** no

Seconds of inactivity before the idle action triggers. Omit to disable idle timeout.

### `idle.action`

- **Type:** `"hibernate" | "destroy"`
- **Default:** `"hibernate"`

What to do when idle:
- `hibernate` — extract overlay, save to storage, destroy container
- `destroy` — destroy container, discard state

### `idle.watch_dirs`

- **Type:** `string[]`
- **Required:** no

Directories to monitor for filesystem changes. If files change, the idle timer resets:

```typescript
watch_dirs: ["/root/.openclaw"]
```

---

## `health`

- **Type:** `object`
- **Required:** no

If omitted, the instance transitions to active immediately after the container starts.

### `health.interval_seconds`

- **Type:** `number`
- **Required:** yes (when `health` is present)

Polling interval for health probes.

### `health.unhealthy_threshold`

- **Type:** `number`
- **Required:** yes (when `health` is present)

Number of consecutive health check failures before the instance is considered unhealthy.

### `health.check_timeout_seconds`

- **Type:** `number`
- **Default:** `60`

Total time to wait for the container to become healthy before giving up.

### `health.http_get`

- **Type:** `{ path: string, port?: number }`

HTTP GET health probe. The check passes on any 2xx response.

```typescript
http_get: { path: "/health", port: 8080 }
```

If `port` is omitted, the first exposed port is used.

### `health.exec`

- **Type:** `{ command: string[] }`

Exec health probe. The check passes on exit code 0.

```typescript
exec: { command: ["pg_isready"] }
```

Only one of `http_get` or `exec` should be specified.

---

## `entrypoint`

- **Type:** `object`
- **Required:** no

Override the container's default entrypoint.

### `entrypoint.cmd`

- **Type:** `string`

The command to run.

### `entrypoint.args`

- **Type:** `string[]`

Arguments to the command.

### `entrypoint.workdir`

- **Type:** `string`

Working directory.

### `entrypoint.env`

- **Type:** `Record<string, string>`

Environment variables.

---

## `pool`

- **Type:** `object`
- **Required:** no

### `pool.size`

- **Type:** `number`
- **Default:** `3`

Number of warm instances to maintain.

### `pool.max_fill_concurrency`

- **Type:** `number`
- **Default:** `2`

Maximum number of instances to create in parallel when filling the pool.

---

## `metadata`

- **Type:** `Record<string, unknown>`
- **Required:** no

Arbitrary metadata. Stored with the workload and returned in API responses.

```typescript
metadata: {
  description: "My AI agent",
  homepage: "https://example.com",
  connect_url: "http://{{host}}:{{port}}/",
}
```
