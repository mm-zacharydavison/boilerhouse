# CRD Reference

Complete reference for Boilerhouse Kubernetes Custom Resource Definitions.

All resources use API group `boilerhouse.dev` and version `v1alpha1`. The authoritative schemas are generated from `go/api/v1alpha1/*_types.go` and live in `config/crd/bases-go/`.

---

## BoilerhouseWorkload

Short name: `bhw`. Defines a container workload — image, resources, network, health checks, and idle policy.

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
    access: restricted
    allowlist:
      - api.anthropic.com
    expose:
      - guest: 8080
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
    encryptOverlays: true
  idle:
    timeoutSeconds: 300
    action: hibernate
    watchDirs:
      - /workspace
  health:
    intervalSeconds: 5
    unhealthyThreshold: 10
    httpGet:
      path: /health
      port: 8080
  entrypoint:
    cmd: node
    args: ["server.js"]
    workdir: /app
    env:
      NODE_ENV: production
```

### Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | yes | Workload version |
| `image.ref` | string | yes* | OCI image reference |
| `image.dockerfile` | string | yes* | Dockerfile path relative to `WORKLOADS_DIR` (mutually exclusive with `ref`) |
| `resources.vcpus` | integer | yes | CPU cores |
| `resources.memoryMb` | integer | yes | Memory in megabytes |
| `resources.diskGb` | integer | yes | Scratch disk in gigabytes |
| `network.access` | string | no | `none`, `restricted`, or `unrestricted` |
| `network.allowlist` | string[] | no | Allowed domains (for `restricted`) |
| `network.expose` | array | no | Port exposures |
| `network.expose[].guest` | integer | no | Container port |
| `network.websocket` | string | no | WebSocket path |
| `network.credentials` | array | no | Per-domain credential injection |
| `network.credentials[].domain` | string | no | Target domain |
| `network.credentials[].headers` | array | no | Headers to inject |
| `network.credentials[].headers[].name` | string | yes | HTTP header name |
| `network.credentials[].headers[].value` | string | no | Literal header value |
| `network.credentials[].headers[].valueFrom.secretKeyRef.name` | string | yes | Kubernetes Secret name |
| `network.credentials[].headers[].valueFrom.secretKeyRef.key` | string | yes | Key within the Secret |
| `filesystem.overlayDirs` | string[] | no | Directories to persist across hibernation |
| `filesystem.encryptOverlays` | bool | no | Reserved (storage-class level encryption in practice) |
| `idle.timeoutSeconds` | integer | no | Idle timeout before hibernation/destroy |
| `idle.action` | string | no | `hibernate` or `destroy` |
| `idle.watchDirs` | string[] | no | Directories whose mtime changes reset the idle timer |
| `health.intervalSeconds` | integer | no | Readiness probe interval |
| `health.unhealthyThreshold` | integer | no | Failure count before unhealthy |
| `health.httpGet.path` | string | no | HTTP probe path |
| `health.httpGet.port` | integer | no | HTTP probe port |
| `health.exec.command` | string[] | no | Exec probe command |
| `entrypoint.cmd` | string | no | Override container command |
| `entrypoint.args` | string[] | no | Command arguments |
| `entrypoint.workdir` | string | no | Working directory |
| `entrypoint.env` | map | no | Environment variables |

\* Exactly one of `image.ref` / `image.dockerfile` must be set.

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Creating`, `Ready`, or `Error` |
| `detail` | string | Human-readable phase detail |
| `observedGeneration` | integer | Last reconciled generation |

---

## BoilerhousePool

Short name: `bhp`. Maintains a set of pre-warmed Pods for a workload.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhousePool
metadata:
  name: my-agent-pool
  namespace: boilerhouse
spec:
  workloadRef: my-agent
  size: 5
  maxFillConcurrency: 3
```

### Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workloadRef` | string | yes | Name of the BoilerhouseWorkload to pool |
| `size` | integer | yes | Number of warm instances to maintain (min 0) |
| `maxFillConcurrency` | integer | no | Max parallel instance creations (min 1) |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `ready` | integer | Number of ready instances |
| `warming` | integer | Number of instances starting up |
| `phase` | string | `Healthy`, `Degraded`, or `Error` |

---

## BoilerhouseClaim

Short name: `bhc`. Represents a tenant's claim on an instance. Create a Claim to allocate a Pod; delete it to release.

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

Claim name convention: `claim-<tenantId>-<workloadRef>`.

### Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | string | yes | Tenant identifier |
| `workloadRef` | string | yes | Name of the BoilerhouseWorkload |
| `resume` | boolean | no | Restore tenant's previous overlay data |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Pending`, `Active`, `Releasing`, `Released`, `ReleaseFailed`, or `Error` |
| `instanceId` | string | Name of the Pod assigned to this claim |
| `endpoint.host` | string | Pod IP or Service host |
| `endpoint.port` | integer | Service port |
| `source` | string | How the instance was provisioned: `existing`, `cold`, `cold+data`, `pool`, `pool+data` |
| `claimedAt` | string | Timestamp the claim reached `Active` |
| `detail` | string | Human-readable phase detail |

### Lifecycle

1. **Create** the Claim resource
2. Operator sets phase to `Pending`, then allocates an instance
3. Phase transitions to `Active` with endpoint details
4. **Delete** the Claim resource to release (or rely on idle timeout)
5. Operator extracts overlay, destroys the Pod, sets phase to `Released`

---

## BoilerhouseTrigger

Short name: `bht`. Connects external events to tenant claims.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: tg-my-agent
  namespace: boilerhouse
spec:
  type: telegram
  workloadRef: my-agent
  tenant:
    from: usernameOrId
    prefix: "tg-"
  driver: claude-code
  guards:
    - type: allowlist
      config:
        tenantIds: ["tg-alice", "tg-bob"]
  config:
    botTokenSecretRef:
      name: telegram-bot-token
      key: token
    updateTypes: ["message"]
    pollTimeoutSeconds: 30
```

### Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `webhook`, `slack`, `telegram`, or `cron` |
| `workloadRef` | string | yes | Target workload name |
| `tenant.static` | string | yes* | Static tenant ID |
| `tenant.from` | string | yes* | Field to extract tenant ID from |
| `tenant.prefix` | string | no | Prefix for extracted tenant ID |
| `driver` | string | no | Protocol driver (`claude-code`, `openclaw`, or unset for plain HTTP) |
| `driverOptions` | map | no | Driver configuration (free-form) |
| `guards` | array | no | Authorization guard chain |
| `guards[].type` | string | no | Guard type (`allowlist`, `api`) |
| `guards[].config` | map | no | Guard configuration (free-form) |
| `config` | map | no | Adapter-specific configuration (see [Trigger Schema](./trigger-schema)) |

\* Exactly one of `tenant.static` / `tenant.from` must be set.

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Active` or `Error` |
| `detail` | string | Human-readable phase detail |

---

## Labels

The operator labels managed resources with:

| Label | Value |
|-------|-------|
| `boilerhouse.dev/managed` | `true` |
| `boilerhouse.dev/workload` | Workload name |
| `boilerhouse.dev/tenant` | Tenant ID (claimed Pods only) |
| `boilerhouse.dev/pool` | Pool name (pool Pods only) |
| `boilerhouse.dev/pool-status` | `warming` or `ready` (pool Pods only) |

## Annotations

| Annotation | Where | Meaning |
|------------|-------|---------|
| `boilerhouse.dev/last-activity` | `BoilerhouseClaim` | Timestamp of the most recent API activity — used by the idle monitor |
