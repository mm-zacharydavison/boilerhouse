# CRD Reference

Complete reference for Boilerhouse Kubernetes Custom Resource Definitions.

All resources use API group `boilerhouse.dev` and version `v1alpha1`.

---

## BoilerhouseWorkload

Defines a container workload — image, resources, network, health checks, and idle policy.

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
        hostRange: [30000, 30099]
    websocket: /ws
    credentials:
      - domain: api.anthropic.com
        headers:
          x-api-key: secret:ANTHROPIC_API_KEY
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
    checkTimeoutSeconds: 120
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
| `image.dockerfile` | string | yes* | Dockerfile path (mutually exclusive with `ref`) |
| `resources.vcpus` | integer | yes | CPU cores |
| `resources.memoryMb` | integer | yes | Memory in MB |
| `resources.diskGb` | integer | no | Disk in GB (default: 2) |
| `network.access` | string | yes | `none`, `unrestricted`, or `restricted` |
| `network.allowlist` | string[] | no | Allowed domains (for `restricted`) |
| `network.expose` | array | no | Port exposures |
| `network.expose[].guest` | integer | yes | Container port |
| `network.expose[].hostRange` | [int, int] | yes | Host port range |
| `network.websocket` | string | no | WebSocket path |
| `network.credentials` | array | no | Per-domain credential injection |
| `network.credentials[].domain` | string | yes | Target domain |
| `network.credentials[].headers` | map | yes | Headers to inject |
| `filesystem.overlayDirs` | string[] | no | Directories to persist |
| `filesystem.encryptOverlays` | boolean | no | Encrypt at rest (default: true) |
| `idle.timeoutSeconds` | integer | no | Idle timeout |
| `idle.action` | string | no | `hibernate` or `destroy` (default: hibernate) |
| `idle.watchDirs` | string[] | no | Directories to monitor for activity |
| `health.intervalSeconds` | integer | yes | Probe interval |
| `health.unhealthyThreshold` | integer | yes | Failure count |
| `health.checkTimeoutSeconds` | integer | no | Total timeout (default: 60) |
| `health.httpGet.path` | string | yes* | HTTP probe path |
| `health.httpGet.port` | integer | no | HTTP probe port |
| `health.exec.command` | string[] | yes* | Exec probe command |
| `entrypoint.cmd` | string | no | Override command |
| `entrypoint.args` | string[] | no | Command arguments |
| `entrypoint.workdir` | string | no | Working directory |
| `entrypoint.env` | map | no | Environment variables |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Creating`, `Ready`, or `Error` |
| `observedGeneration` | integer | Last reconciled generation |

---

## BoilerhousePool

Maintains a set of pre-warmed instances for a workload.

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
| `size` | integer | yes | Number of warm instances to maintain |
| `maxFillConcurrency` | integer | no | Max parallel instance creations (default: 2) |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `ready` | integer | Number of ready instances |
| `warming` | integer | Number of instances starting up |
| `phase` | string | `Healthy`, `Degraded`, or `Error` |

---

## BoilerhouseClaim

Represents a tenant's claim on an instance. Create a Claim to allocate an instance; delete it to release.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseClaim
metadata:
  name: alice-my-agent
  namespace: boilerhouse
spec:
  tenantId: alice
  workloadRef: my-agent
  resume: true
```

### Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | string | yes | Tenant identifier |
| `workloadRef` | string | yes | Name of the BoilerhouseWorkload |
| `resume` | boolean | no | Restore tenant's previous overlay data (default: false) |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Pending`, `Active`, `Releasing`, `Released`, or `Error` |
| `instanceId` | string | Allocated instance ID |
| `source` | string | How the instance was provisioned: `existing`, `cold`, `cold+data`, `pool`, `pool+data` |
| `endpoint.host` | string | Pod IP or forwarded host |
| `endpoint.port` | integer | Service port |
| `claimedAt` | string | ISO 8601 timestamp |
| `message` | string | Error message (when phase is Error) |

### Lifecycle

1. **Create** the Claim resource
2. Operator sets phase to `Pending`, then allocates an instance
3. Phase transitions to `Active` with endpoint details
4. **Delete** the Claim resource to release
5. Operator extracts overlay, hibernates/destroys instance, sets phase to `Released`

Idle timeout also releases claims — the operator annotates the claim and transitions to `Released`.

---

## BoilerhouseTrigger

Connects external events to tenant claims.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: tg-my-agent
  namespace: boilerhouse
spec:
  type: telegram-poll
  workloadRef: my-agent
  tenant:
    from: usernameOrId
    prefix: "tg-"
  driver: "@boilerhouse/driver-claude-code"
  driverOptions: {}
  guards:
    - type: allowlist
      config:
        tenantIds: ["tg-alice", "tg-bob"]
  config:
    botToken: "${TELEGRAM_BOT_TOKEN}"
    updateTypes: ["message"]
    pollTimeoutSeconds: 30
```

### Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `webhook`, `slack`, `telegram-poll`, or `cron` |
| `workloadRef` | string | yes | Target workload name |
| `tenant.from` | string | yes* | Field to extract tenant ID from |
| `tenant.prefix` | string | no | Prefix for extracted tenant ID |
| `tenant.static` | string | yes* | Static tenant ID (mutually exclusive with `from`) |
| `driver` | string | no | Protocol driver package |
| `driverOptions` | map | no | Driver configuration |
| `guards` | array | no | Authorization guard chain |
| `guards[].type` | string | yes | Guard type (`allowlist`, `api`) |
| `guards[].config` | map | yes | Guard configuration |
| `config` | map | yes | Adapter-specific configuration (see [Trigger Schema](./trigger-schema)) |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Active` or `Error` |
| `message` | string | Error details |

---

## Finalizers

All Boilerhouse CRDs use the finalizer `boilerhouse.dev/cleanup`. This ensures the operator can clean up associated resources (Pods, Services, database rows) before the Kubernetes resource is deleted.

Do not remove the finalizer manually unless you're debugging a stuck deletion.

## Labels

The operator labels managed resources with:

| Label | Value |
|-------|-------|
| `boilerhouse.dev/managed` | `true` |
| `boilerhouse.dev/workload` | workload name |
| `boilerhouse.dev/instance` | instance ID |
| `boilerhouse.dev/pool` | pool name (pool instances only) |
