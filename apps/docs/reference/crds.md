# CRD Reference

Boilerhouse defines four Custom Resource Definitions in the `boilerhouse.dev` API group, all at version `v1alpha1`. These CRDs are used by the [Kubernetes operator](../guide/runtime-kubernetes.md) to manage workloads, pools, claims, and triggers declaratively.

## BoilerhouseWorkload

**Kind:** `BoilerhouseWorkload`
**Short name:** `bhw`
**Scope:** Namespaced

Defines a container workload blueprint — the image, resources, networking, health checks, and idle policy.

### Spec

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | Yes | Workload version identifier |
| `image.ref` | string | Yes | OCI image reference |
| `resources.vcpus` | integer | Yes | CPU cores |
| `resources.memoryMb` | integer | Yes | Memory in megabytes |
| `resources.diskGb` | integer | Yes | Disk in gigabytes |
| `network.access` | `"none"` \| `"restricted"` \| `"unrestricted"` | No | Network access mode |
| `network.expose[]` | array | No | Port mappings |
| `network.expose[].guest` | integer | Yes | Port inside the container |
| `network.allowlist[]` | string[] | No | Allowed outbound domains |
| `network.credentials[]` | array | No | Credential injection rules |
| `network.credentials[].domain` | string | Yes | Target domain |
| `network.credentials[].secretRef.name` | string | Yes | Kubernetes Secret name |
| `network.credentials[].secretRef.key` | string | Yes | Key within the Secret |
| `network.credentials[].headers` | map | Yes | Headers to inject (value is the header value template) |
| `network.websocket` | string | No | WebSocket path |
| `filesystem.overlayDirs[]` | string[] | No | Directories to persist across hibernation |
| `filesystem.encryptOverlays` | boolean | No | Encrypt overlays at rest |
| `idle.timeoutSeconds` | integer | No | Seconds before idle action |
| `idle.action` | `"hibernate"` \| `"destroy"` | No | Action on idle timeout |
| `idle.watchDirs[]` | string[] | No | Directories to monitor for activity |
| `health.intervalSeconds` | integer | No | Health check interval |
| `health.unhealthyThreshold` | integer | No | Failures before unhealthy |
| `health.httpGet.path` | string | No | HTTP probe path |
| `health.httpGet.port` | integer | No | HTTP probe port |
| `health.exec.command[]` | string[] | No | Exec probe command |
| `entrypoint.cmd` | string | No | Container command |
| `entrypoint.args[]` | string[] | No | Command arguments |
| `entrypoint.env` | map | No | Environment variables |
| `entrypoint.workdir` | string | No | Working directory |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `"Creating"` \| `"Ready"` \| `"Error"` | Current phase |
| `detail` | string | Error message (when phase is Error) |
| `observedGeneration` | integer | Last observed resource generation |

### Example

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: my-agent
spec:
  version: "0.1.0"
  image:
    ref: ghcr.io/org/my-agent:latest
  resources:
    vcpus: 1
    memoryMb: 512
    diskGb: 5
  network:
    access: restricted
    allowlist:
      - api.anthropic.com
    expose:
      - guest: 8080
  health:
    intervalSeconds: 2
    unhealthyThreshold: 30
    httpGet:
      path: /health
  idle:
    timeoutSeconds: 300
    action: hibernate
  entrypoint:
    cmd: node
    args: ["server.js"]
```

### Printer Columns

| Name | Field | Type |
|------|-------|------|
| Phase | `.status.phase` | string |
| Version | `.spec.version` | string |
| Image | `.spec.image.ref` | string |
| Age | `.metadata.creationTimestamp` | date |

---

## BoilerhousePool

**Kind:** `BoilerhousePool`
**Short name:** `bhp`
**Scope:** Namespaced

Maintains a pool of pre-warmed instances for a workload. See [Pooling](../guide/pooling.md) for how pools work.

### Spec

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `workloadRef` | string | Yes | — | Name of the BoilerhouseWorkload |
| `size` | integer | Yes | — | Target number of warm instances |
| `maxFillConcurrency` | integer | No | 1 | Max parallel instance starts |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `ready` | integer | Instances ready for claiming |
| `warming` | integer | Instances still starting |
| `phase` | `"Healthy"` \| `"Degraded"` \| `"Error"` | Pool health |

### Example

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhousePool
metadata:
  name: my-agent-pool
spec:
  workloadRef: my-agent
  size: 3
  maxFillConcurrency: 2
```

### Printer Columns

| Name | Field | Type |
|------|-------|------|
| Workload | `.spec.workloadRef` | string |
| Size | `.spec.size` | integer |
| Ready | `.status.ready` | integer |
| Phase | `.status.phase` | string |

---

## BoilerhouseClaim

**Kind:** `BoilerhouseClaim`
**Short name:** `bhc`
**Scope:** Namespaced

Binds a tenant to a running instance. Creating a claim triggers instance provisioning; deleting it releases the instance.

### Spec

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | string | Yes | Tenant identifier |
| `workloadRef` | string | Yes | Name of the BoilerhouseWorkload |
| `resume` | boolean | No | Restore from tenant's last snapshot |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `"Pending"` \| `"Active"` \| `"Releasing"` \| `"Released"` \| `"Error"` | Claim phase |
| `instanceId` | string | Assigned instance ID |
| `endpoint.host` | string | Instance hostname or IP |
| `endpoint.port` | integer | Instance port |
| `source` | `"existing"` \| `"cold"` \| `"cold+data"` \| `"pool"` \| `"pool+data"` | How the instance was provisioned |
| `claimedAt` | string (RFC 3339) | When the claim became active |
| `detail` | string | Error message (when phase is Error) |

### Example

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseClaim
metadata:
  name: alice-my-agent
spec:
  tenantId: alice
  workloadRef: my-agent
  resume: true
```

### Printer Columns

| Name | Field | Type |
|------|-------|------|
| Tenant | `.spec.tenantId` | string |
| Workload | `.spec.workloadRef` | string |
| Phase | `.status.phase` | string |
| Endpoint | `.status.endpoint.host` | string |
| Age | `.metadata.creationTimestamp` | date |

---

## BoilerhouseTrigger

**Kind:** `BoilerhouseTrigger`
**Short name:** `bht`
**Scope:** Namespaced

Registers an event trigger that routes external events to agent instances. See [Triggers](../guide/triggers.md) for details.

### Spec

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"webhook"` \| `"slack"` \| `"telegram"` \| `"cron"` | Yes | Adapter type |
| `workloadRef` | string | Yes | Target workload name |
| `tenant.from` | string | No | Field path to extract tenant ID from event |
| `tenant.prefix` | string | No | Prefix for extracted tenant ID |
| `driver` | string | No | Driver package name |
| `driverOptions` | object | No | Driver configuration |
| `guards[]` | array | No | Guard chain |
| `guards[].type` | string | Yes | Guard type |
| `guards[].config` | object | No | Guard-specific config |
| `config` | object | No | Adapter-specific configuration |

### Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `"Active"` \| `"Error"` | Trigger status |
| `detail` | string | Error message |

### Example

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: slack-support
spec:
  type: slack
  workloadRef: support-agent
  tenant:
    from: user_id
    prefix: "slack-"
  driver: "@boilerhouse/driver-openclaw"
  guards:
    - type: allowlist
      config:
        tenantIds: ["slack-U12345", "slack-U67890"]
  config:
    signingSecret: "..."
    botToken: "xoxb-..."
    eventTypes: ["message", "app_mention"]
```

### Printer Columns

| Name | Field | Type |
|------|-------|------|
| Type | `.spec.type` | string |
| Workload | `.spec.workloadRef` | string |
| Phase | `.status.phase` | string |
