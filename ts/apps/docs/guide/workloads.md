# Workloads

A workload is the central configuration unit in Boilerhouse. It defines everything about a container: what image to run, how much CPU and memory to allocate, what network access it gets, when to hibernate, and how to check its health.

## Defining a Workload

Workloads are `BoilerhouseWorkload` Custom Resources:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: my-agent
  namespace: boilerhouse
spec:
  version: "1.0.0"
  image:
    ref: my-registry/my-agent:latest
  resources:
    vcpus: 2
    memoryMb: 2048
    diskGb: 10
  network:
    access: none
  idle:
    timeoutSeconds: 300
    action: hibernate
```

Apply with `kubectl apply -f`. The `metadata.name` is the identifier you pass in claim requests (`{"workload": "my-agent"}`), and `spec.version` tracks configuration changes.

## Image Sources

Exactly one of `image.ref` or `image.dockerfile` must be set.

### Pre-built Image

Reference an image from a registry:

```yaml
image:
  ref: alpine:3.19
```

```yaml
image:
  ref: ghcr.io/myorg/my-agent:v2
```

### Dockerfile

Build from a Dockerfile relative to the workloads directory:

```yaml
image:
  dockerfile: my-agent/Dockerfile
```

When set, the operator builds the image inside the cluster and tags it as `boilerhouse/<name>:<version>`. For minikube, `WORKLOADS_DIR` on the operator should point at the checked-out `workloads/` directory.

## Resources

Every workload declares its resource requirements:

```yaml
resources:
  vcpus: 2       # CPU cores (maps to Pod cpu request/limit)
  memoryMb: 4096 # memory in megabytes
  diskGb: 20     # emptyDir volume size for overlay scratch
```

These map to Pod resource requests and limits.

## Entrypoint

Override the container's default entrypoint:

```yaml
entrypoint:
  cmd: node
  args: ["server.js"]
  workdir: /app
  env:
    NODE_ENV: production
    PORT: "8080"
```

Environment variables set here are baked into the container at creation time.

## Network Access

Control what network access the container gets:

```yaml
# No network at all
network:
  access: none
```

```yaml
# Full internet access
network:
  access: unrestricted
```

```yaml
# Restricted to specific domains
network:
  access: restricted
  allowlist:
    - api.openai.com
    - registry.npmjs.org
```

For `restricted` access, a NetworkPolicy limits egress to DNS and HTTPS, and (when `credentials` is set) an Envoy sidecar enforces the allowlist and injects headers. See [Networking & Security](./networking).

### Exposing Ports

Expose container ports so claims can return an endpoint:

```yaml
network:
  access: restricted
  expose:
    - guest: 8080
```

`guest` is the port inside the container. The operator creates a `ClusterIP` Service routing to the Pod. The claim response returns the Service address and port.

### WebSocket Path

If your workload speaks WebSocket, declare the path:

```yaml
network:
  access: restricted
  expose:
    - guest: 7880
  websocket: /ws
```

The `websocket` path is copied into claim responses so clients know where to connect.

### Credential Injection

Inject API keys into outbound requests via the Envoy sidecar:

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
  --from-literal=key="<your Anthropic API key>"
```

The Envoy sidecar intercepts HTTPS requests to the specified domain, terminates TLS using a generated CA (trusted inside the container), injects the headers, and forwards the request. The container never sees the key.

## Filesystem Overlays

Declare directories whose contents should be persisted across hibernation cycles:

```yaml
filesystem:
  overlayDirs:
    - /workspace
    - /home/user
  encryptOverlays: true
```

When a tenant's instance is released or hibernated, the operator extracts these directories as a tar archive through a helper pod and stores them in a PVC. On the next claim, the archive is injected back into a fresh container.

## Health Checks

Define how Boilerhouse determines when a container is ready.

### HTTP

```yaml
health:
  intervalSeconds: 5
  unhealthyThreshold: 10
  httpGet:
    path: /health
    port: 8080
```

Becomes the Pod's readiness probe. The instance is considered ready after the first successful 2xx response.

### Exec

```yaml
health:
  intervalSeconds: 5
  unhealthyThreshold: 10
  exec:
    command: ["pg_isready"]
```

Runs a command inside the container. Exit code 0 means healthy.

## Idle Policy

Control what happens when a container goes idle:

```yaml
idle:
  timeoutSeconds: 300   # 5 minutes of inactivity
  action: hibernate     # or "destroy"
```

- `hibernate` — extracts overlay, destroys Pod, saves state for later restoration
- `destroy` — destroys Pod and discards state

### Watch Directories

For workloads where filesystem activity indicates usage (e.g., coding agents), add watch directories:

```yaml
idle:
  timeoutSeconds: 60
  action: hibernate
  watchDirs:
    - /root/.openclaw
```

The operator periodically checks these directories for modification time changes. If files change, the idle timer resets.

## Pooling

Pools are a separate resource. See [Pooling](./pooling) for details.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhousePool
metadata:
  name: my-agent-pool
  namespace: boilerhouse
spec:
  workloadRef: my-agent
  size: 3
  maxFillConcurrency: 2
```

## Example Workloads

Full examples are in the `workloads/` directory of the repo.

### Minimal (Testing)

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: minimal
  namespace: boilerhouse
spec:
  version: "0.1.0"
  image:
    dockerfile: minimal/Dockerfile
  resources:
    vcpus: 1
    memoryMb: 128
    diskGb: 1
  network:
    access: none
  idle:
    timeoutSeconds: 300
    action: hibernate
  entrypoint:
    cmd: sh
    args: ["-c", "echo 'minimal container ready' && exec sleep infinity"]
```

### HTTP Server (Demo)

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: httpserver
  namespace: boilerhouse
spec:
  version: "0.1.0"
  image:
    dockerfile: httpserver/Dockerfile
  resources:
    vcpus: 1
    memoryMb: 256
    diskGb: 1
  network:
    access: unrestricted
    expose:
      - guest: 8080
  idle:
    timeoutSeconds: 300
    action: hibernate
  health:
    intervalSeconds: 2
    unhealthyThreshold: 30
    httpGet:
      path: /
      port: 8080
  entrypoint:
    cmd: python3
    args: ["-m", "http.server", "8080"]
```

### Claude Code (AI Agent)

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: claude-code
  namespace: boilerhouse
spec:
  version: "2026.3.26d"
  image:
    dockerfile: claude-code/Dockerfile
  resources:
    vcpus: 2
    memoryMb: 4096
    diskGb: 20
  network:
    access: restricted
    allowlist:
      - api.anthropic.com
      - statsig.anthropic.com
      - registry.npmjs.org
      - github.com
      - api.github.com
    expose:
      - guest: 7880
    websocket: /ws
    credentials:
      - domain: api.anthropic.com
        headers:
          - name: x-api-key
            valueFrom:
              secretKeyRef:
                name: anthropic-api
                key: key
  filesystem:
    overlayDirs:
      - /workspace
      - /home/claude
  idle:
    timeoutSeconds: 300
    action: hibernate
  health:
    intervalSeconds: 2
    unhealthyThreshold: 30
    httpGet:
      path: /health
      port: 7880
  entrypoint:
    cmd: node
    args: ["bridge.mjs"]
    workdir: /app
    env:
      ANTHROPIC_API_KEY: sk-ant-proxy-managed
      ANTHROPIC_BASE_URL: http://api.anthropic.com
      CLAUDE_MODEL: sonnet
      BRIDGE_PORT: "7880"
      WORKSPACE_DIR: /workspace
```

## Full Schema Reference

See [Workload Schema Reference](../reference/workload-schema) for the complete field-by-field schema.
