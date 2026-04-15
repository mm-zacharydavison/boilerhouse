# Architecture

## System Overview

Boilerhouse is structured as a set of deployable services backed by shared libraries. The major components are:

**API server** (`apps/api`). The primary interface. Exposes REST and WebSocket endpoints for workload registration, tenant claims, instance management, and observability. Built with [Elysia](https://elysiajs.com/) on Bun. Routes delegate to the domain layer for business logic.

**Operator** (`apps/operator`). A Kubernetes controller that reconciles Boilerhouse CRDs (`Workload`, `Claim`) into domain operations. Leader-elected for high availability. Translates Kubernetes-native resource definitions into the same domain calls the API server uses.

**Trigger Gateway** (`apps/trigger-gateway`). Receives external events from webhooks, Slack, Telegram, and cron schedules. Each trigger defines a tenant resolution strategy. The gateway resolves the tenant, claims or wakes their instance, and forwards the event payload to the container via a driver.

**Domain layer** (`packages/domain`). Runtime-agnostic business logic shared by the API server and the Operator. Contains three core managers:

- `TenantManager` -- orchestrates claims, releases, overlay injection, and idle monitoring.
- `InstanceManager` -- creates, destroys, hibernates, and restores container instances via the runtime abstraction.
- `PoolManager` -- maintains warm pools of ready instances and handles replenishment after claims.

**Runtimes** (`packages/runtime-docker`, `packages/runtime-kubernetes`). Thin adapters over container creation, destruction, health checking, and snapshotting. Both implement a shared `Runtime` interface, so the domain layer is unaware of the underlying container engine.

**Database** (`packages/db`). SQLite via [Drizzle ORM](https://orm.drizzle.team/). Stores workloads, instances, tenants, claims, snapshots, nodes, and the audit log. Single-file database with no external dependencies.

**Storage** (`packages/storage`). Blob store for filesystem overlays and snapshots. Supports local disk, S3, tiered caching (S3 primary with LRU disk cache), and optional at-rest encryption via the secret key.

**Observability** (`packages/o11y`). OpenTelemetry instrumentation for metrics and tracing. Wraps domain managers with trace spans. Exposes Prometheus metrics on a configurable port.

## Monorepo Structure

```
apps/
  api/                 REST + WebSocket API server
  operator/            Kubernetes CRD controller
  cli/                 CLI tool (compiles to single binary)
  dashboard/           Web dashboard
  trigger-gateway/     Event ingestion (webhooks, Slack, Telegram, cron)
  docs/                This documentation site (VitePress)

packages/
  core/                Shared types, state machines, workload schema, validation
  db/                  SQLite schema, migrations, Drizzle ORM setup
  domain/              Business logic (TenantManager, InstanceManager, PoolManager)
  runtime-docker/      Docker runtime adapter
  runtime-kubernetes/  Kubernetes runtime adapter
  storage/             Blob store (disk, S3, tiered, encrypted)
  triggers/            Trigger definitions and tenant resolution
  k8s/                 Kubernetes client wrapper
  o11y/                OpenTelemetry metrics, tracing, structured logging
  envoy-config/        Envoy sidecar proxy configuration
  guard-allowlist/     Network allowlist enforcement
  guard-api/           API guard middleware
  driver-claude-code/  Driver for Claude Code agent containers
  driver-openclaw/     Driver for OpenClaw containers
  driver-pi/           Driver for Pi containers

workloads/             Example workload and trigger definitions
tests/                 Integration, E2E, and security tests
```

## Claim Flow

When `POST /tenants/:id/claim` is called, the following sequence executes:

1. **Validate request.** The API looks up the workload by name and confirms it is in `ready` status. If the node is at capacity, returns `503 Retry-After`.

2. **Check existing claim.** `TenantManager` checks whether this tenant already has an active claim for the workload. If so, verifies the backing instance is still running and returns the existing endpoint immediately (source: `existing`).

3. **Reserve claim slot.** Upserts the tenant identity row, cleans up any previously hibernated instances, and inserts a new claim row in `creating` status. The `UNIQUE` constraint on `tenantId + workloadId` prevents concurrent duplicate claims.

4. **Resolve instance.** Two paths:
   - **Pool path.** If the workload has a pool and the tenant has no prior overlay data, `PoolManager.acquire()` grabs a pre-warmed instance. The instance is already running and health-checked. Source: `pool`. Typical latency: under 500ms.
   - **Cold boot path.** If the pool is empty or the tenant has existing overlay data that must be injected at creation time, a new instance is created from scratch via the runtime. If the tenant has a prior snapshot, the overlay archive is restored and mounted. Source: `cold` or `cold+data`. Typical latency: 3-10 seconds.

5. **Inject overlay.** If the tenant has stored overlay data from a previous session, it is injected into the container's filesystem before the instance is returned.

6. **Activate and return.** The claim transitions to `active`. Activity timestamps are updated. Idle monitoring begins. The response includes the endpoint (host + port mapping), instance ID, source, and claim latency.

After a successful pool claim, the pool manager asynchronously replenishes the pool to maintain the configured warm count.

## Instance State Machine

Each instance follows a strict state machine. Transitions are validated; invalid transitions throw an `InvalidTransitionError`.

```
                  +-----------+
                  | starting  |
                  +-----+-----+
                  |           |
           started|           |restoring
                  v           v
             +--------+  +-----------+
             | active |  | restoring |
             +---+----+  +-----+-----+
                 |              |
        hibernate|       restored|
                 v              v
          +-----------+    +--------+
          |hibernating|    | active |
          +-----+-----+   +--------+
                |
      hibernated|  hibernating_failed
           +----+-----+
           v           v
     +-----------+ +-----------+
     | hibernated| | destroying|
     +-----------+ +-----+-----+
           |              |
  restoring|        destroyed|
           v              v
     +-----------+ +-----------+
     | restoring | | destroyed |
     +-----------+ +-----------+
```

Every state except `destroyed` can transition to `destroying` via the `destroy` event. The full transition table:

| Current State | Event | Next State |
|---|---|---|
| `starting` | `started` | `active` |
| `starting` | `restoring` | `restoring` |
| `starting` | `destroy` | `destroying` |
| `restoring` | `restored` | `active` |
| `restoring` | `destroy` | `destroying` |
| `active` | `hibernate` | `hibernating` |
| `active` | `destroy` | `destroying` |
| `hibernating` | `hibernated` | `hibernated` |
| `hibernating` | `hibernating_failed` | `destroying` |
| `hibernated` | `restoring` | `restoring` |
| `hibernated` | `destroy` | `destroying` |
| `destroying` | `destroyed` | `destroyed` |

## Data Flow

How a workload definition becomes a running container:

1. **Validation.** The workload config (JSON or TypeScript via `defineWorkload()`) is validated against a TypeBox schema in `packages/core`. This enforces required fields, type constraints, and valid enum values for network access, idle actions, and health check types.

2. **Storage.** The validated workload is stored in the SQLite `workloads` table with status `creating`. The full config is stored as a JSON column.

3. **Pool priming.** If the workload defines a `pool.size`, the `PoolManager` creates that many instances in the background. Each instance goes through the full creation flow: image pull/build, container start, health check. Instances that pass health checks are marked `ready` in the pool.

4. **Container creation.** The runtime adapter (`DockerRuntime` or `KubernetesRuntime`) translates the workload config into runtime-specific operations: building or pulling the image, creating the container with resource limits and network rules, mounting overlay directories, and starting the process.

5. **Health checking.** The `InstanceManager` polls the configured health endpoint (`http_get` or `exec` probe) at the configured interval. An instance transitions to `active` only after the health check passes. If the check fails more times than `unhealthy_threshold`, the instance is destroyed.

6. **Registration.** Once active, the instance is registered in the `instances` table with its status, endpoint mapping, node assignment, and pool status. It is now available for tenant claims.

::: warning
Workloads remain in `creating` status until pool priming completes. API calls to claim instances from a workload that is not yet `ready` will receive a `503` response.
:::
