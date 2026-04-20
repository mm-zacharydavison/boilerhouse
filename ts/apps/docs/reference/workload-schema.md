# Workload Schema Reference

Complete reference for `BoilerhouseWorkload.spec`. The authoritative schema is generated from `go/api/v1alpha1/workload_types.go` and validated by the CRD.

## Top-Level Structure

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: my-agent
  namespace: boilerhouse
spec:
  version: <string>           # required
  image: <ImageConfig>        # required
  resources: <Resources>      # required
  network: <Network>          # optional
  filesystem: <Filesystem>    # optional
  idle: <IdleConfig>          # optional
  health: <HealthCheck>       # optional
  entrypoint: <Entrypoint>    # optional
```

When creating workloads via the REST API, wrap these fields:

```json
{
  "name": "my-agent",
  "spec": {
    "version": "1.0.0",
    "image": { "ref": "..." },
    "resources": { "vcpus": 2, "memoryMb": 2048, "diskGb": 10 }
  }
}
```

---

## `metadata.name`

- **Type:** `string`
- **Required:** yes

The workload identifier. Used in claim requests (`{"workload": "my-agent"}`) and as the referenced name in `BoilerhousePool.spec.workloadRef` / `BoilerhouseClaim.spec.workloadRef`. Must be a valid Kubernetes resource name.

## `spec.version`

- **Type:** `string`
- **Required:** yes

The workload version string. Tracks configuration changes. Surfaced in kubectl output and API responses.

---

## `spec.image`

- **Type:** object
- **Required:** yes

Exactly one of `ref` or `dockerfile` must be set.

### `image.ref`

- **Type:** `string`

OCI image reference from a container registry:

```yaml
image:
  ref: alpine:3.19
```

### `image.dockerfile`

- **Type:** `string`

Path to a Dockerfile, relative to the operator's `WORKLOADS_DIR`:

```yaml
image:
  dockerfile: my-agent/Dockerfile
```

When set, the operator builds the image inside the cluster and tags it `boilerhouse/<name>:<version>`.

---

## `spec.resources`

- **Type:** object
- **Required:** yes

```yaml
resources:
  vcpus: 2        # CPU cores
  memoryMb: 2048  # memory in megabytes
  diskGb: 10      # scratch disk in gigabytes
```

| Field | Type | Required |
|-------|------|----------|
| `vcpus` | integer | yes |
| `memoryMb` | integer | yes |
| `diskGb` | integer | yes |

These map to Pod resource requests and limits.

---

## `spec.network`

- **Type:** object
- **Required:** no

### `network.access`

- **Type:** `string` — one of `none`, `restricted`, `unrestricted`

| Value | Description |
|-------|-------------|
| `none` | Deny all egress via NetworkPolicy |
| `restricted` | Allow DNS + HTTPS only; Envoy sidecar enforces allowlist + injects credentials when configured |
| `unrestricted` | Allow all egress except link-local (169.254.0.0/16) |

### `network.allowlist`

- **Type:** `string[]`

Domains the container is allowed to reach (for `restricted` mode). Supports wildcards like `*.github.com`.

### `network.expose`

- **Type:** array of `{ guest: integer }`

Ports to expose via a `ClusterIP` Service:

```yaml
expose:
  - guest: 8080
```

### `network.websocket`

- **Type:** `string`

WebSocket path. Returned in claim responses so clients know where to connect:

```yaml
websocket: /ws
```

### `network.credentials`

- **Type:** array

Inject HTTP headers into outbound requests for specific domains. Triggers the Envoy sidecar.

```yaml
credentials:
  - domain: api.anthropic.com
    headers:
      - name: x-api-key
        valueFrom:
          secretKeyRef:
            name: anthropic-api
            key: key
      - name: x-client-id
        value: public-static-value
```

| Field | Type | Description |
|-------|------|-------------|
| `domain` | string | Target domain |
| `headers[].name` | string | HTTP header name |
| `headers[].value` | string | Literal value (exclusive with `valueFrom`) |
| `headers[].valueFrom.secretKeyRef.name` | string | Kubernetes Secret name in the operator's namespace |
| `headers[].valueFrom.secretKeyRef.key` | string | Key within the Secret |

---

## `spec.filesystem`

- **Type:** object
- **Required:** no

### `filesystem.overlayDirs`

- **Type:** `string[]`

Directories to persist across hibernation cycles. Each becomes an `emptyDir` volume that gets extracted as a tar archive on release.

```yaml
filesystem:
  overlayDirs:
    - /workspace
    - /home/user
```

### `filesystem.encryptOverlays`

- **Type:** `bool`

Reserved for future use. In the current implementation, overlay encryption at rest is the responsibility of the snapshot PVC's storage class.

---

## `spec.idle`

- **Type:** object
- **Required:** no

### `idle.timeoutSeconds`

- **Type:** `integer`

Seconds of inactivity before the idle action triggers. Omit to disable idle timeout.

### `idle.action`

- **Type:** `string` — one of `hibernate`, `destroy`

- `hibernate` — extract overlay, destroy Pod, preserve state for next claim
- `destroy` — destroy Pod, discard state

### `idle.watchDirs`

- **Type:** `string[]`

Directories to monitor for filesystem changes. If files are modified, the idle timer resets.

```yaml
idle:
  timeoutSeconds: 300
  action: hibernate
  watchDirs:
    - /workspace
```

---

## `spec.health`

- **Type:** object
- **Required:** no

If omitted, the Pod is considered ready as soon as the container starts.

### `health.intervalSeconds`

- **Type:** `integer`

Readiness probe interval.

### `health.unhealthyThreshold`

- **Type:** `integer`

Number of consecutive failures before the Pod is marked unready.

### `health.httpGet`

- **Type:** `{ path: string, port: integer }`

HTTP GET probe. Passes on any 2xx response.

```yaml
health:
  intervalSeconds: 5
  unhealthyThreshold: 10
  httpGet:
    path: /health
    port: 8080
```

### `health.exec`

- **Type:** `{ command: string[] }`

Exec probe. Passes on exit code 0.

```yaml
health:
  intervalSeconds: 5
  unhealthyThreshold: 10
  exec:
    command: ["pg_isready"]
```

Only one of `httpGet` or `exec` should be specified.

---

## `spec.entrypoint`

- **Type:** object
- **Required:** no

Override the container's default entrypoint.

```yaml
entrypoint:
  cmd: node
  args: ["server.js"]
  workdir: /app
  env:
    NODE_ENV: production
    PORT: "8080"
```

| Field | Type |
|-------|------|
| `cmd` | string |
| `args` | string[] |
| `workdir` | string |
| `env` | map of string → string |

---

## Status

Written by the operator, read by `kubectl` and the API.

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Creating`, `Ready`, or `Error` |
| `detail` | string | Human-readable phase detail |
| `observedGeneration` | integer | Last reconciled generation |
