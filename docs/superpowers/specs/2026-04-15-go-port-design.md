# Boilerhouse Go Port — Design Spec

## Summary

Port the entire Boilerhouse platform from TypeScript/Bun to Go. Drop the Docker runtime. Unify on Kubernetes as the sole container runtime and state store. No SQLite database — the K8s API server is the single source of truth. Use controller-runtime for the operator. Workload definitions switch from TypeScript DSL to YAML.

This is a full rewrite, not a migration. Work happens on an `experimental/go` branch until validated.

## Motivation

The current TypeScript codebase maintains two parallel systems: a Docker runtime with SQLite state, and a Kubernetes operator that must keep its CRDs in sync with that same SQLite database. This dual-state architecture is the root cause of most bugs — the DB and K8s disagree about what's running.

By going fully K8s-native, the K8s API server becomes the only state store. Pods ARE instances. CRDs ARE workloads, claims, and triggers. PVCs ARE overlay storage. There is no second source of truth to synchronize.

### What We Delete

| Current concept | Replacement |
|---|---|
| SQLite database (10 tables) | K8s API server (CRDs + native resources) |
| `Runtime` interface + 2 implementations | Direct client-go calls in controllers |
| `InstanceManager` | Reconciler manages Pods directly; kubelet handles health |
| `PoolManager` (DB-backed) | Pool reconciler using Pod labels |
| `TenantDataStore` + `BlobStore` | PersistentVolumeClaims that outlive Pods |
| `IdleMonitor` (goroutine-per-instance) | Reconciler with `requeueAfter` + activity annotations |
| `nodes` table | K8s scheduler handles node assignment |
| `activity_log` table | K8s Events on CRD objects + structured logging |
| `tenant_secrets` table (AES-256-GCM) | K8s Secrets (with etcd encryption at rest) |

### What Remains

- **Workload validation** — parsing YAML, enforcing constraints
- **Claim semantics** — "this tenant owns this instance" is a Boilerhouse concept
- **Credential injection / Envoy sidecar** — K8s doesn't do MITM credential injection
- **Trigger gateway** — external event routing, entirely outside K8s
- **REST API** — thin translation layer between HTTP and K8s API
- **Network policy generation** — translating access modes to NetworkPolicy specs

## Architecture

### How State is Stored

Everything lives in the K8s API server. No external database.

| Data | K8s Resource | How it's queried |
|------|-------------|-----------------|
| Workload definitions | `BoilerhouseWorkload` CRD | `kubectl get bhw` / K8s API list |
| Pool configuration | `BoilerhousePool` CRD | `kubectl get bhp` |
| Tenant claims | `BoilerhouseClaim` CRD | `kubectl get bhc -l boilerhouse.dev/tenant=alice` |
| Trigger config | `BoilerhouseTrigger` CRD | `kubectl get bht` |
| Running instances | Pods with label `boilerhouse.dev/managed=true` | Pod list with label selector |
| Pool status | Pod label `boilerhouse.dev/pool-status=ready` | Label selector |
| Tenant ownership | Pod label `boilerhouse.dev/tenant=<id>` | Label selector |
| Overlay data | PersistentVolumeClaims named `overlay-<tenant>-<workload>` | PVC list |
| Tenant secrets | K8s Secrets named `bh-secret-<tenant>` | Secret get |
| Audit trail | K8s Events on CRD objects + structured log output | Event list / log aggregation |
| Network policy | NetworkPolicy per instance | Managed by reconciler |
| Sidecar config | ConfigMap per instance | Managed by reconciler |

### Overlay Persistence via PVCs

This replaces the tar/extract/inject cycle entirely.

When a workload defines `overlay_dirs`, the ClaimController:
1. Creates (or reuses) a PVC named `overlay-<tenant>-<workload>`
2. The Pod spec mounts the PVC at each overlay dir
3. The application writes to those dirs normally
4. When the Pod is deleted (release/hibernate), the PVC persists
5. When the same tenant claims again, the new Pod mounts the same PVC
6. Data is already there — no extraction or injection needed

For k3s single-node, the default `local-path-provisioner` backs PVCs with host directories. This is functionally equivalent to Docker bind mounts.

PVC access mode is `ReadWriteOnce` — only one Pod can mount it at a time, which matches the one-claim-per-tenant-per-workload constraint.

### Idle Monitoring via Reconciler

Instead of a goroutine per instance polling for activity:

1. The API server (or trigger gateway) updates an annotation `boilerhouse.dev/last-activity` on the Claim CRD whenever traffic is routed to the instance
2. The ClaimController reconciles with `requeueAfter: idleTimeout / 2`
3. On each reconcile, it checks the annotation timestamp against the workload's idle timeout
4. If expired, it triggers release (delete the Pod, keep the PVC)

No goroutines, no timers, no in-memory state. The reconciler is the idle monitor.

### Binaries

| Binary | Role |
|--------|------|
| `boilerhouse-operator` | K8s operator. Watches CRDs, reconciles Pods/Services/PVCs/NetworkPolicies. |
| `boilerhouse-api` | REST API. Translates HTTP requests into CRD operations via the K8s API. |
| `boilerhouse-trigger` | Trigger gateway. Receives external events, creates/updates Claims. |

### Monorepo Layout

```
go/
  go.mod                     # module: github.com/zdavison/boilerhouse/go
  go.sum
  cmd/
    operator/main.go
    api/main.go
    trigger/main.go

  internal/
    core/
      workload.go            # Workload config struct + YAML parsing + validation
      workload_test.go
      errors.go

    operator/
      workload_controller.go       # validates spec, sets Ready/Error status
      workload_controller_test.go
      pool_controller.go            # maintains warm Pods via label selectors
      pool_controller_test.go
      claim_controller.go           # claims Pods, manages PVCs, idle detection
      claim_controller_test.go
      trigger_controller.go         # manages trigger adapter lifecycle
      trigger_controller_test.go
      translator.go                 # Workload → Pod/Service/NetworkPolicy/ConfigMap/PVC specs
      translator_test.go
      sidecar.go                    # Envoy proxy sidecar injection
      sidecar_test.go

    api/
      server.go              # chi router, middleware, auth
      routes_workload.go     # CRUD on BoilerhouseWorkload CRDs
      routes_tenant.go       # claim/release via BoilerhouseClaim CRDs
      routes_instance.go     # Pod list/get/exec/logs
      routes_trigger.go      # CRUD on BoilerhouseTrigger CRDs
      routes_secret.go       # CRUD on K8s Secrets
      routes_system.go       # health, stats
      websocket.go           # real-time event stream via K8s Watch

    trigger/
      gateway.go
      adapter_webhook.go
      adapter_slack.go
      adapter_telegram.go
      adapter_cron.go
      driver.go
      guard.go
      tenant_resolution.go

    o11y/
      logger.go              # structured logging (slog)
      metrics.go             # Prometheus metrics

    envoy/
      config.go              # Envoy YAML generation for sidecar proxy

  api/
    v1alpha1/
      workload_types.go
      pool_types.go
      claim_types.go
      trigger_types.go
      groupversion_info.go
      zz_generated.deepcopy.go

ts/
  apps/
    dashboard/
    docs/

config/
  crd/bases/
  rbac/
  deploy/

workloads/
  minimal.yaml
  claude-code.yaml
```

**Deleted from the previous plan:** `internal/db/`, `internal/storage/`, `internal/domain/`, `internal/runtime/`. The domain logic lives in the operator controllers. The storage is PVCs. The database is the K8s API.

### Key Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Operator | controller-runtime v0.19+ | Industry standard. Built-in leader election, envtest, finalizer helpers, shared cache. |
| HTTP server | `net/http` + `chi` v5 | Lightweight, idiomatic. |
| Logging | `log/slog` (stdlib) | Structured logging, no dependency. |
| Metrics | `prometheus/client_golang` | controller-runtime exports through it. |
| YAML parsing | `sigs.k8s.io/yaml` | K8s-flavored YAML. |
| Config | Environment variables | Same as current. |

No SQLite. No ORM. No blob store SDK.

## CRDs

### BoilerhouseWorkload

Unchanged from current. Defines the container blueprint.

### BoilerhousePool

Unchanged from current. Defines warm pool size for a workload.

### BoilerhouseClaim

Extended with idle tracking:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseClaim
metadata:
  name: alice-my-agent
  annotations:
    boilerhouse.dev/last-activity: "2026-04-15T10:35:00Z"  # updated by API/trigger
spec:
  tenantId: alice
  workloadRef: my-agent
  resume: true
status:
  phase: Active
  instanceId: inst_abc123
  endpoint:
    host: 10.42.0.5
    port: 8080
  source: pool
  claimedAt: "2026-04-15T10:30:00Z"
```

### BoilerhouseTrigger

Unchanged from current.

## Workload YAML Format

Same as the previous spec version — YAML files parsed into Go structs. No change.

## Tenant Secrets

Stored as K8s Secrets in the Boilerhouse namespace:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: bh-secret-alice
  namespace: boilerhouse
  labels:
    boilerhouse.dev/tenant: alice
type: Opaque
data:
  ANTHROPIC_API_KEY: <base64>
  OPENAI_KEY: <base64>
```

For encryption at rest, enable etcd encryption in k3s:

```yaml
# /etc/rancher/k3s/config.yaml
secrets-encryption: true
```

The credential injection sidecar reads these Secrets at claim time and injects headers.

## How Each Operation Works

### Claim an Instance

1. API receives `POST /tenants/alice/claim` with `{"workload": "my-agent"}`
2. API creates (or finds existing) `BoilerhouseClaim` CRD for tenant `alice` + workload `my-agent`
3. ClaimController reconciles:
   a. If Claim already Active with a running Pod → return existing endpoint (source: `existing`)
   b. Look for a Pool Pod with label `boilerhouse.dev/pool-status=ready` for this workload
   c. If found: relabel Pod with `boilerhouse.dev/tenant=alice`, `boilerhouse.dev/pool-status=acquired`. Attach PVC if tenant has one. Update Claim status. (source: `pool` or `pool+data`)
   d. If not found: create a new Pod with PVC. (source: `cold` or `cold+data`)
4. Wait for Pod Running + readiness probe passing
5. Update Claim status with endpoint, source, claimedAt

### Release an Instance

1. API receives `POST /tenants/alice/release` with `{"workload": "my-agent"}`
2. API deletes the `BoilerhouseClaim` CRD
3. ClaimController sees `deletionTimestamp`, runs finalizer:
   a. Delete the Pod (PVC persists — overlay data is safe)
   b. Remove finalizer
4. PoolController notices pool is below target → starts a replacement Pod

### Idle Timeout

1. ClaimController reconciles a Claim, checks `boilerhouse.dev/last-activity` annotation
2. If `now - lastActivity > workload.idle.timeoutSeconds`:
   a. If idle action is `hibernate`: delete Pod (PVC persists), set Claim status to `Released`
   b. If idle action is `destroy`: delete Pod AND PVC, set Claim status to `Released`
3. If not idle: `requeueAfter(remainingTime)`

### Pool Warming

1. PoolController reconciles a Pool CRD
2. Lists Pods with labels `boilerhouse.dev/workload=<name>`, `boilerhouse.dev/pool-status` in (`warming`, `ready`)
3. If `count < pool.spec.size`: creates new Pods with `pool-status=warming`
4. When Pod becomes Ready (readiness probe): relabels to `pool-status=ready`
5. `requeueAfter(10s)` for continuous monitoring

## Verification Strategy

Same approach as the previous spec, adapted:

1. **Functional behavioral tests** — test the scenarios listed above (claim from pool, cold boot, overlay restore, idle timeout, etc.) using envtest
2. **Translator snapshot tests** — capture expected Pod/Service/NetworkPolicy YAML from the TS translator, assert Go produces equivalent output
3. **Workload validation tests** — table-driven tests for parsing and validation
4. **E2E tests** — run against a real k3s cluster, exercise the full claim→work→release→reclaim cycle

## Environment Variables

Simplified — no DB or storage config needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server port |
| `LISTEN_HOST` | `127.0.0.1` | API bind address |
| `K8S_NAMESPACE` | `boilerhouse` | Namespace for all Boilerhouse resources |
| `BOILERHOUSE_API_KEY` | — | Optional API auth token |
| `METRICS_PORT` | `9464` | Prometheus metrics port |
| `WORKLOADS_DIR` | — | YAML workload definitions directory |
| `CORS_ORIGIN` | — | Comma-separated CORS origins |
| `REDIS_URL` | `redis://localhost:6379` | Trigger queue |

Deleted: `DB_PATH`, `STORAGE_PATH`, `BOILERHOUSE_SECRET_KEY`, `S3_*`, `OVERLAY_CACHE_*`, `MAX_INSTANCES`, `DOCKER_SOCKET`, `SECCOMP_PROFILE_PATH`, `RUNTIME_TYPE`.

## Out of Scope

- Docker runtime (deleted)
- SQLite database (deleted)
- Blob storage backends (deleted — PVCs replace this)
- Dashboard (ported separately later)
- Quint formal specification (not ready)
- Trigger driver packages (claude-code, openclaw, pi) — ported after core works

## Branch Strategy

All work happens on the `experimental/go` branch. The TS codebase on `main` remains untouched.

The first commit restructures the repo:

1. Move existing TS code into `ts/`
2. Create `go/` with `go.mod`
3. Move CRD YAML to `config/crd/bases/`

Go code is added incrementally under `go/`. Once validated, `ts/` is removed on main.
