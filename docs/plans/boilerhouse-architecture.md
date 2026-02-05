# Boilerhouse Architecture

## Overview

Boilerhouse is a generic container pool orchestrator that manages containerized workloads with configurable state synchronization. It provides pre-warmed container pools, tenant isolation, and bidirectional state sync to external storage.

## Goals

1. **Generic Container Pooling**: Provision and manage warm pools of any container image
2. **Tenant Isolation**: Claim containers for users with isolated state/secrets
3. **Bidirectional State Sync**: Sync state to external sinks (S3, etc.) and restore into containers
4. **Monitoring Dashboard**: Real-time visibility into pool status, container health, and sync state

---

## Current State Analysis

### Core Components

| Component            | Location                                  | Description                               |
|----------------------|-------------------------------------------|-------------------------------------------|
| ContainerRuntime     | `packages/core/src/runtime.ts`            | Abstract interface, Docker/K8s ready      |
| ContainerManager     | `apps/api/lib/container/manager.ts`       | Lifecycle management, fully generic       |
| ContainerPool        | `apps/api/lib/container/pool.ts`          | Pre-warmed pool with generic-pool         |
| DockerRuntime        | `packages/docker/src/docker-runtime.ts`   | Docker implementation of runtime          |
| WorkloadRegistry     | `apps/api/lib/workload/loader.ts`         | YAML-based workload configuration         |
| SyncCoordinator      | `apps/api/lib/sync/coordinator.ts`        | State sync lifecycle management           |
| Security Model       | `packages/core/src/defaults.ts`           | Read-only root, dropped caps, non-root    |

---

## Architecture

### Core Concepts

```
┌─────────────────────────────────────────────────────────────────────────┐
│                             Boilerhouse API                              │
├─────────────────────────────────────────────────────────────────────────┤
│  Workload Registry    │    Pool Manager    │    State Sync Engine       │
│  ─────────────────    │    ────────────    │    ─────────────────       │
│  - Workload specs     │    - Warm pools    │    - Sink adapters         │
│  - Config schemas     │    - Claim/release │    - Source adapters       │
│  - Health checks      │    - Sticky routes │    - Sync policies         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐   ┌──────────┐   ┌──────────┐
              │ Pool A   │   │ Pool B   │   │ Pool C   │
              │ (image1) │   │ (image2) │   │ (image1) │
              └──────────┘   └──────────┘   └──────────┘
                    │               │               │
              ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
              ▼           ▼   ▼           ▼   ▼           ▼
           [C1]        [C2]  [C3]       [C4] [C5]       [C6]
           warm      tenant  warm     tenant warm     tenant
                       "A"                "B"            "C"
```

### New Type Definitions

```typescript
// Workload specification - defines how to run a container type
interface WorkloadSpec {
  id: WorkloadId
  name: string
  image: string

  // Volume configuration
  volumes: {
    state?: { containerPath: string; mode: 'rw' | 'ro' }
    secrets?: { containerPath: string; mode: 'ro' }
    comm?: { containerPath: string; mode: 'rw' }
    custom?: Array<{ name: string; containerPath: string; mode: 'rw' | 'ro' }>
  }

  // Environment variables template (supports ${VAR} substitution)
  environment: Record<string, string>

  // Health check configuration
  healthCheck: {
    command: string[]
    intervalMs: number
    timeoutMs: number
    retries: number
  }

  // Resource limits (can override pool defaults)
  resources?: Partial<ResourceLimits>

  // Security overrides (subset of defaults allowed)
  security?: {
    readOnlyRootFilesystem?: boolean
    runAsUser?: number
    networkMode?: 'none' | 'bridge' | 'host' | string
  }

  // Config schema for tenant state (JSON Schema)
  configSchema?: JSONSchema
}

// Pool configuration
interface PoolSpec {
  id: PoolId
  workloadId: WorkloadId
  minSize: number
  maxSize: number
  idleTimeoutMs: number

  // Network configuration
  network?: {
    name: string
    dns?: string[]
  }
}

// State sync configuration
interface SyncSpec {
  id: SyncId
  poolId: PoolId

  // What to sync
  paths: Array<{
    containerPath: string    // e.g., "/state/sessions"
    pattern?: string         // e.g., "*.jsonl"
    direction: 'outward' | 'inward' | 'bidirectional'
  }>

  // Where to sync
  sink: SinkConfig

  // When to sync
  policy: {
    intervalMs?: number      // Periodic sync
    onRelease?: boolean      // Sync when container released
    realtime?: boolean       // Stream changes (Fluent Bit)
  }
}

// Sink configurations
type SinkConfig =
  | { type: 's3'; bucket: string; prefix: string; region: string }
  | { type: 'gcs'; bucket: string; prefix: string }
  | { type: 'azure-blob'; container: string; prefix: string }
  | { type: 'http'; endpoint: string; headers?: Record<string, string> }
  | { type: 'local'; path: string }

// Tenant assignment
interface TenantAssignment {
  tenantId: TenantId
  poolId: PoolId
  containerId?: ContainerId
  state: 'pending' | 'assigned' | 'releasing'
  config: Record<string, unknown>  // Validated against workload's configSchema
  secrets: TenantSecrets
  assignedAt?: Date
  lastActivityAt?: Date
}
```

---

## API Design

### Base URL: `/api/v1`

### Workload Management

```
POST   /workloads              Create a workload spec
GET    /workloads              List all workload specs
GET    /workloads/:id          Get workload spec
PUT    /workloads/:id          Update workload spec
DELETE /workloads/:id          Delete workload spec (fails if pools exist)
```

### Pool Management

```
POST   /pools                  Create a pool for a workload
GET    /pools                  List all pools
GET    /pools/:id              Get pool status (size, claimed, idle)
PUT    /pools/:id              Update pool config (min/max size, timeout)
DELETE /pools/:id              Delete pool (drains containers first)

POST   /pools/:id/scale        Scale pool to target size
GET    /pools/:id/containers   List containers in pool
```

### Tenant Operations

```
POST   /tenants/:tenantId/claim
  Body: { poolId, config, secrets }
  Response: { containerId, endpoints }

  Claims a container from the pool for the tenant.
  - Provisions state/secrets to container
  - Restores state from sink if available
  - Returns container connection info

POST   /tenants/:tenantId/release
  Body: { sync?: boolean }

  Releases container back to pool.
  - Syncs state to sink if requested
  - Cleans tenant data from container
  - Returns container to warm pool

GET    /tenants/:tenantId/status
  Response: {
    assigned: boolean
    containerId?: string
    poolId?: string
    syncStatus: { lastSync, pending, errors }
  }

POST   /tenants/:tenantId/sync
  Body: { direction: 'outward' | 'inward' | 'both' }

  Triggers manual state sync for tenant.
```

### Sync Configuration

```
POST   /sync-specs             Create sync specification
GET    /sync-specs             List sync specifications
GET    /sync-specs/:id         Get sync spec details
PUT    /sync-specs/:id         Update sync spec
DELETE /sync-specs/:id         Delete sync spec

GET    /sync-specs/:id/status  Get sync status (last run, errors, metrics)
POST   /sync-specs/:id/trigger Manually trigger sync
```

### Container Operations (Admin)

```
GET    /containers             List all containers
GET    /containers/:id         Get container details
POST   /containers/:id/exec    Execute command in container
DELETE /containers/:id         Force remove container
```

### Health & Metrics

```
GET    /health                 API health check
GET    /metrics                Prometheus metrics endpoint
GET    /stats                  Pool and sync statistics
```

---

## State Sync Engine (rclone)

Boilerhouse uses **rclone** as the unified sync mechanism for moving data between containers and external storage backends. This provides a consistent interface regardless of the underlying storage provider.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Boilerhouse API                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────┐         ┌────────────────────────────────┐  │
│  │   Sync Registry   │         │        Sync Coordinator        │  │
│  │   ─────────────   │         │        ────────────────        │  │
│  │   - SyncSpec[]    │────────▶│   - Schedules periodic syncs   │  │
│  │   - Path mappings │         │   - Handles claim/release      │  │
│  │   - Sink configs  │         │   - Manages rclone processes   │  │
│  └───────────────────┘         └────────────────────────────────┘  │
│                                              │                      │
└──────────────────────────────────────────────┼──────────────────────┘
                                               │
                          ┌────────────────────┼────────────────────┐
                          ▼                    ▼                    ▼
                   ┌────────────┐       ┌────────────┐       ┌────────────┐
                   │ Container  │       │ Container  │       │ Container  │
                   │  /data     │       │  /state    │       │  /output   │
                   └─────┬──────┘       └─────┬──────┘       └─────┬──────┘
                         │                    │                    │
                         └────────────────────┼────────────────────┘
                                              │
                                      ┌───────┴───────┐
                                      │    rclone     │
                                      │   (per-sync)  │
                                      └───────┬───────┘
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
             ┌────────────┐           ┌────────────┐           ┌────────────┐
             │     S3     │           │    GCS     │           │   Azure    │
             │  (v1 only) │           │  (future)  │           │  (future)  │
             └────────────┘           └────────────┘           └────────────┘
```

### Developer-Defined Sync Configuration

Developers using Boilerhouse define **what** data to sync and **where** to store it via `SyncSpec`:

```typescript
// Developer defines sync mappings per workload/pool
interface SyncSpec {
  id: SyncId
  poolId: PoolId

  // What to sync - developer specifies container paths
  mappings: SyncMapping[]

  // Where to sync - developer chooses sink
  sink: SinkConfig

  // When to sync
  policy: SyncPolicy
}

interface SyncMapping {
  // Source path inside container (e.g., "/data/sessions")
  containerPath: string

  // Optional glob pattern (e.g., "*.json", "**/*.log")
  pattern?: string

  // Destination path prefix in sink (e.g., "sessions/")
  sinkPath: string

  // Sync direction
  direction: 'upload' | 'download' | 'bidirectional'

  // Sync behavior
  mode: 'sync' | 'copy'  // sync deletes removed files, copy doesn't
}

interface SyncPolicy {
  // Sync on container lifecycle events
  onClaim?: boolean       // Download state when tenant claims container
  onRelease?: boolean     // Upload state when tenant releases container

  // Periodic sync while container is claimed
  intervalMs?: number     // e.g., 60000 for every minute

  // Sync on API trigger
  allowManualTrigger?: boolean
}

// v1: Only S3 supported
type SinkConfig = S3SinkConfig  // Future: | GCSSinkConfig | AzureSinkConfig | ...

interface S3SinkConfig {
  type: 's3'
  bucket: string
  region: string
  prefix: string          // Base path, e.g., "tenants/${tenantId}/"

  // Credentials (or use IAM role)
  accessKeyId?: string
  secretAccessKey?: string

  // rclone-specific options
  rcloneFlags?: string[]  // e.g., ["--s3-upload-cutoff=100M"]
}
```

### Example: Defining Sync for a Workload

```typescript
// Developer creates a sync spec for their ML training workload
const mlWorkloadSync: SyncSpec = {
  id: 'ml-training-sync' as SyncId,
  poolId: 'ml-gpu-pool' as PoolId,

  mappings: [
    {
      // Checkpoints - bidirectional, restore on claim, save on release
      containerPath: '/data/checkpoints',
      pattern: '*.pt',
      sinkPath: 'checkpoints/',
      direction: 'bidirectional',
      mode: 'sync',
    },
    {
      // Logs - upload only, periodic
      containerPath: '/data/logs',
      pattern: '**/*.log',
      sinkPath: 'logs/',
      direction: 'upload',
      mode: 'copy',  // Don't delete old logs from S3
    },
    {
      // Config - download only on claim
      containerPath: '/config',
      sinkPath: 'config/',
      direction: 'download',
      mode: 'sync',
    },
  ],

  sink: {
    type: 's3',
    bucket: 'my-ml-data',
    region: 'us-west-2',
    prefix: 'workloads/ml/${tenantId}/',  // Interpolated per-tenant
  },

  policy: {
    onClaim: true,        // Restore checkpoints when claiming
    onRelease: true,      // Save checkpoints when releasing
    intervalMs: 300000,   // Also sync every 5 minutes while running
    allowManualTrigger: true,
  },
}
```

### rclone Integration

Boilerhouse manages rclone processes for each sync operation:

```typescript
// Internal: How Boilerhouse executes syncs
class RcloneSyncExecutor {
  async sync(
    tenantId: TenantId,
    mapping: SyncMapping,
    sink: SinkConfig,
    containerVolumePath: string,  // Host path to container's volume
  ): Promise<SyncResult> {

    // Build rclone remote path
    const remotePath = this.buildRemotePath(sink, tenantId, mapping.sinkPath)
    const localPath = join(containerVolumePath, mapping.containerPath)

    // Build rclone command
    const args = [
      mapping.mode,  // 'sync' or 'copy'
      mapping.direction === 'download' ? remotePath : localPath,
      mapping.direction === 'download' ? localPath : remotePath,
    ]

    if (mapping.pattern) {
      args.push('--include', mapping.pattern)
    }

    // Execute rclone
    const result = await this.execRclone(args, sink)
    return result
  }
}
```

### Sync Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     Container Claim Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Tenant calls POST /tenants/:id/claim                        │
│  2. Boilerhouse assigns container from pool                     │
│  3. For each SyncSpec with onClaim=true:                        │
│     a. For each mapping with direction=download|bidirectional:  │
│        - rclone sync s3://bucket/tenant/path → /container/path  │
│  4. Provision tenant config and secrets                         │
│  5. Return container info to tenant                             │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                    Container Release Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Tenant calls POST /tenants/:id/release                      │
│  2. For each SyncSpec with onRelease=true:                      │
│     a. For each mapping with direction=upload|bidirectional:    │
│        - rclone sync /container/path → s3://bucket/tenant/path  │
│  3. Clean container state                                       │
│  4. Return container to pool                                    │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                      Periodic Sync Flow                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Sync coordinator checks all active containers               │
│  2. For each SyncSpec with intervalMs set:                      │
│     - If time since last sync >= intervalMs:                    │
│       - Execute upload mappings via rclone                      │
│       - Update lastSyncAt timestamp                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### v1 Scope

For v1, the sync engine will support:

| Feature                    | v1 Support |
|----------------------------|------------|
| S3 as sink                 | ✅          |
| GCS, Azure, etc.           | ❌ (future) |
| Upload sync                | ✅          |
| Download sync (restore)    | ✅          |
| Bidirectional sync         | ✅          |
| onClaim / onRelease        | ✅          |
| Periodic sync              | ✅          |
| Manual trigger API         | ✅          |
| Glob patterns              | ✅          |
| Path interpolation         | ✅ (${tenantId}) |
| Concurrent syncs           | ✅          |
| Sync progress/status API   | ✅          |
| Encryption at rest         | ❌ (use S3 SSE) |
| Compression                | ❌ (future) |

---

## Dashboard Design

### Technology Stack

- **Framework**: React + Vite (already in monorepo tooling)
- **UI Library**: Tailwind CSS + shadcn/ui
- **State Management**: TanStack Query (react-query)
- **Charts**: Recharts or Chart.js
- **WebSocket**: Native WebSocket for real-time updates

### Pages

#### 1. Overview Dashboard (`/`)

```
┌─────────────────────────────────────────────────────────────────┐
│  Boilerhouse Dashboard                            [Settings] [?] │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │ Total Pools │  │ Containers  │  │  Tenants    │  │  Sync   │ │
│  │      3      │  │   45 / 50   │  │    23       │  │   OK    │ │
│  │             │  │  90% used   │  │  active     │  │ 2 warn  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘ │
│                                                                  │
│  Pool Status                                         [+ New Pool]│
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Pool         │ Workload    │ Containers │ Claimed │ Status │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ prod-agents  │ python-wkr  │  20 / 25   │   18    │   ●    │ │
│  │ dev-sandbox  │ sandbox-v2  │   5 / 10   │    2    │   ●    │ │
│  │ ml-workers   │ pytorch-gpu │  10 / 15   │    3    │   ◐    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Recent Activity                              [View All]         │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 14:32:01  tenant-abc claimed container c-1234 (prod-agents)│ │
│  │ 14:31:45  sync completed for tenant-xyz (1.2 MB → S3)      │ │
│  │ 14:30:22  container c-5678 returned to pool                │ │
│  │ 14:29:58  pool ml-workers scaled up (8 → 10)               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 2. Pool Detail (`/pools/:id`)

- Container list with status (warm, claimed, unhealthy)
- Pool configuration editor
- Scaling controls (manual scale, edit min/max)
- Resource usage charts (CPU, memory over time)
- Container lifecycle events

#### 3. Tenant View (`/tenants/:id`)

- Assigned container info
- State sync status and history
- Config viewer (with schema validation status)
- Manual sync trigger
- Release button

#### 4. Sync Monitor (`/sync`)

- Active sync jobs
- Sync history with success/failure
- Data transfer metrics
- Error logs
- Sink health status

#### 5. Workload Registry (`/workloads`)

- List of registered workloads
- Schema editor (JSON Schema)
- Volume/env configuration
- Health check configuration

#### 6. Settings (`/settings`)

- Global configuration
- Sink credentials management
- Network configuration
- Security policies

### Real-time Updates

```typescript
// WebSocket events from API
interface DashboardEvent {
  type:
    | 'container.created'
    | 'container.claimed'
    | 'container.released'
    | 'container.destroyed'
    | 'container.unhealthy'
    | 'sync.started'
    | 'sync.completed'
    | 'sync.failed'
    | 'pool.scaled'
    | 'pool.warning'
  payload: Record<string, unknown>
  timestamp: Date
}
```

---

## Implementation Phases

### Phase 1: Core Abstraction (Foundation) ✅

**Goal**: Generic workload-based container management

1. **Define new types** in `packages/core/src/types.ts`
   - `WorkloadSpec`, `PoolSpec`, `SyncSpec`
   - `TenantAssignment`, `PoolContainer`
   - `SinkConfig` union type

2. **Create WorkloadRegistry** in `apps/api/lib/workload/`
   - YAML file-backed store
   - CRUD operations for workload specs
   - Zod schema validation

3. **ContainerManager**
   - Accept `WorkloadSpec` in `createContainer()`
   - Configurable volume mounts, env vars, health checks

4. **ContainerPool**
   - Associate pools with workload specs
   - Support multiple pools per workload
   - Configurable pool sizing

**Deliverables**:
- Generic container creation
- Workload spec registration
- Multi-pool support

### Phase 2: API Implementation

**Goal**: Complete REST API for all operations

1. **Set up Elysia server** in `apps/api/src/`
   - Request validation with TypeBox
   - Error handling middleware
   - OpenAPI documentation

2. **Implement endpoints**
   - `/workloads/*` - Workload CRUD
   - `/pools/*` - Pool management
   - `/tenants/*` - Claim/release/status
   - `/containers/*` - Admin operations

3. **Add WebSocket support**
   - Event broadcasting for dashboard
   - Per-tenant subscriptions

4. **Authentication/Authorization**
   - API key authentication
   - Role-based access (admin vs tenant)

**Deliverables**:
- Functional REST API
- WebSocket event stream
- API documentation

### Phase 3: State Sync Engine

**Goal**: Configurable bidirectional state synchronization

1. **Implement sink adapters**
   - S3 adapter (existing, needs refactoring)
   - Local filesystem adapter
   - HTTP webhook adapter
   - Interface for custom adapters

2. **Build sync coordinator**
   - Manages sync specs per pool
   - Schedules periodic syncs
   - Handles on-demand triggers

3. **Refactor Fluent Bit integration**
   - Templated config generation
   - Support arbitrary path patterns
   - Multiple output destinations

4. **State restoration**
   - Download from sink on claim
   - Incremental restore (if supported)
   - Validation before injection

**Deliverables**:
- Multiple sink support
- Configurable sync policies
- Reliable state restoration

### Phase 4: Dashboard

**Goal**: Real-time monitoring and management UI

1. **Set up dashboard app**
   - Vite + React + TypeScript
   - Tailwind CSS + shadcn/ui
   - API client generation from OpenAPI

2. **Implement core pages**
   - Overview dashboard
   - Pool management
   - Tenant viewer
   - Sync monitor

3. **Add real-time features**
   - WebSocket integration
   - Live container status
   - Sync progress indicators

4. **Configuration UI**
   - Workload editor with schema builder
   - Pool configuration
   - Sink management

**Deliverables**:
- Functional monitoring dashboard
- Real-time updates
- Configuration management

### Phase 5: Production Hardening

**Goal**: Production-ready deployment

1. **Persistence layer**
   - SQLite/PostgreSQL for registry
   - Migration system
   - Backup/restore

2. **Observability**
   - Prometheus metrics
   - Structured logging
   - Distributed tracing (optional)

3. **High availability**
   - Leader election for sync coordinator
   - Graceful failover
   - State consistency guarantees

4. **Documentation**
   - Deployment guide
   - Workload authoring guide
   - API reference

**Deliverables**:
- Persistent storage
- Production metrics
- Deployment documentation

---

---

## File Structure

```
apps/
├── api/
│   ├── lib/
│   │   ├── container/
│   │   │   ├── manager.ts        # Refactored for WorkloadSpec
│   │   │   └── pool.ts           # Multi-pool support
│   │   ├── workload/
│   │   │   ├── registry.ts       # WorkloadSpec CRUD
│   │   │   ├── schema.ts         # JSON Schema validation
│   │   │   └── defaults.ts       # Built-in workload defaults
│   │   ├── sync/
│   │   │   ├── coordinator.ts    # Sync orchestration
│   │   │   ├── sinks/
│   │   │   │   ├── s3.ts
│   │   │   │   ├── gcs.ts
│   │   │   │   ├── local.ts
│   │   │   │   └── http.ts
│   │   │   └── restore.ts        # State restoration
│   │   ├── state/                # Existing, refactored
│   │   └── config.ts             # Extended configuration
│   └── src/
│       ├── index.ts              # Entry point
│       ├── server.ts             # Elysia setup
│       ├── routes/
│       │   ├── workloads.ts
│       │   ├── pools.ts
│       │   ├── tenants.ts
│       │   ├── sync.ts
│       │   └── admin.ts
│       └── websocket.ts          # Real-time events
├── dashboard/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/
│   │   │   └── client.ts         # Generated from OpenAPI
│   │   ├── components/
│   │   │   ├── ui/               # shadcn components
│   │   │   ├── PoolCard.tsx
│   │   │   ├── ContainerList.tsx
│   │   │   ├── SyncStatus.tsx
│   │   │   └── ...
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Pools.tsx
│   │   │   ├── PoolDetail.tsx
│   │   │   ├── Tenants.tsx
│   │   │   ├── Sync.tsx
│   │   │   ├── Workloads.tsx
│   │   │   └── Settings.tsx
│   │   └── hooks/
│   │       ├── useWebSocket.ts
│   │       └── usePool.ts
│   └── index.html
packages/
├── core/
│   └── src/
│       ├── types.ts              # Extended with new types
│       └── runtime.ts            # Unchanged
└── docker/
    └── src/
        └── docker-runtime.ts     # Unchanged
```

---

## Success Metrics

| Metric                        | Target                              |
|-------------------------------|-------------------------------------|
| Container claim latency       | < 500ms (warm pool hit)             |
| State sync latency            | < 5s for 10MB state                 |
| Pool utilization visibility   | Real-time (< 1s delay)              |
| Workload onboarding time      | < 30 min for new container type     |
| API response time (p99)       | < 100ms for CRUD operations         |
| Dashboard load time           | < 2s initial, < 200ms navigation    |

---

## Design Decisions (v1)

| Question                     | Decision                                                      |
|------------------------------|---------------------------------------------------------------|
| Sync tool                    | rclone - unified interface for multiple backends              |
| Sync backends (v1)           | S3 only - GCS, Azure, etc. deferred to future versions        |
| Realtime streaming           | Deferred - no Fluent Bit in v1, use periodic sync instead     |
| Multi-region support         | Out of scope for v1                                           |
| Container migration          | Not supported - containers stay on their host                 |
| Quota management             | 1 container per tenant (simple model)                         |
| Billing integration          | Not needed for v1                                             |
| Custom runtimes              | Docker only, but keep `ContainerRuntime` interface generic for future Kubernetes support |

---

## References

- [rclone Documentation](https://rclone.org/docs/) - Sync tool used for state management
- [rclone S3 Backend](https://rclone.org/s3/) - S3-compatible storage configuration
- [Fly.io Machines API](https://fly.io/docs/machines/api/machines-resource/)
- [Modal Cold Start Guide](https://modal.com/docs/guide/cold-start)
- [Fission Pre-warming](https://fission.io/docs/)
- [Knative Autoscaling](https://knative.dev/docs/serving/autoscaling/)
- [Firecracker MicroVMs](https://firecracker-microvm.github.io/)

---

## Task List: Boilerhouse Development

This section tracks the work completed to build Boilerhouse as a generic container pool management system.

### Phase 0: Project Setup ✅

| #    | Task                              | Status |
|------|-----------------------------------|--------|
| 0.1  | Set up monorepo structure         | [x]    |
| 0.2  | Configure @boilerhouse/core       | [x]    |
| 0.3  | Configure @boilerhouse/docker     | [x]    |
| 0.4  | Configure @boilerhouse/api        | [x]    |
| 0.5  | Set up BOILERHOUSE_* env vars     | [x]    |
| 0.6  | Configure docker-compose          | [x]    |
| 0.7  | Set up container labels           | [x]    |
| 0.8  | Configure host directory paths    | [x]    |

### Phase 1: Core Types & Interfaces ✅

| #   | Task                                | Status |
|-----|-------------------------------------|--------|
| 1.1 | Define `PoolContainer` interface    | [x]    |
| 1.2 | Define `WorkloadSpec` interface     | [x]    |
| 1.3 | Define `PoolSpec` interface         | [x]    |
| 1.4 | Define `SyncSpec` interface         | [x]    |
| 1.5 | Define `SinkConfig` union type      | [x]    |
| 1.6 | Define `TenantAssignment` interface | [x]    |
| 1.7 | Export all types from @boilerhouse/core | [x] |

### Phase 2: Container Configuration ✅

| #   | Task                                       | Status |
|-----|--------------------------------------------|--------|
| 2.1 | Configurable volume mounts via WorkloadSpec | [x]   |
| 2.2 | Configurable environment variables          | [x]   |
| 2.3 | Configurable health checks                  | [x]   |
| 2.4 | Generic socket naming                       | [x]   |
| 2.5 | Configurable network mode                   | [x]   |
| 2.6 | Container labeling for recovery             | [x]   |

### Phase 3: rclone-Based Sync Engine ✅

| #    | Task                                    | Status |
|------|-----------------------------------------|--------|
| 3.1  | SyncSpec and SyncMapping types          | [x]    |
| 3.2  | S3SinkConfig type                       | [x]    |
| 3.3  | SyncPolicy type                         | [x]    |
| 3.4  | SyncRegistry module                     | [x]    |
| 3.5  | RcloneSyncExecutor                      | [x]    |
| 3.6  | Upload sync (container → S3)            | [x]    |
| 3.7  | Download sync (S3 → container)          | [x]    |
| 3.8  | Bidirectional sync                      | [x]    |
| 3.9  | Glob pattern support                    | [x]    |
| 3.10 | SyncCoordinator                         | [x]    |
| 3.11 | onClaim sync hook                       | [x]    |
| 3.12 | onRelease sync hook                     | [x]    |
| 3.13 | Periodic sync scheduler                 | [x]    |
| 3.14 | Path interpolation (${tenantId})        | [x]    |
| 3.15 | Sync status tracking                    | [x]    |

### Phase 3.1: Migrate Specs to YAML Configuration

**Goal**: Externalize WorkloadSpec and SyncSpec definitions from TypeScript code to declarative YAML files with file-backed registries

**Rationale**: Currently specs are defined inline in TypeScript or stored only in memory. Moving to YAML provides:
- Declarative configuration that operators can modify without code changes
- Persistence across restarts without a database
- Validation via JSON Schema
- Consistency with docker-compose mental model
- API mutations write back to config files (GitOps friendly)

**Design Principle**: Use docker-compose field names and conventions wherever possible to leverage existing user knowledge. Reuse schema types from the [Compose Specification](https://github.com/compose-spec/compose-spec/blob/master/schema/compose-spec.json) where applicable.

#### WorkloadSpec YAML Migration

| #     | Task                                          | Files Affected                                                                 | Status |
|-------|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 3.1.1 | Define YAML schema for WorkloadSpec           | `packages/core/src/schemas/workload.schema.json` (new) - reuse compose types   | [x]    |
| 3.1.2 | Create YAML loader utility                    | `apps/api/lib/workload/loader.ts` (new) - loads and validates YAML files       | [x]    |
| 3.1.3 | Create workloads config directory             | `config/workloads/` (new) - default location for workload YAML files           | [x]    |
| 3.1.4 | Migrate DEFAULT_WORKLOAD to YAML              | `config/workloads/default.yaml` (new) - move from `apps/api/src/index.ts`      | [x]    |
| 3.1.5 | Add BOILERHOUSE_WORKLOADS_DIR env var         | `apps/api/lib/config.ts` - configurable workload directory path                | [x]    |
| 3.1.6 | Update app startup to load from YAML          | `apps/api/src/index.ts` - use loader instead of inline spec                    | [x]    |
| 3.1.7 | Add workload reload capability                | `apps/api/lib/workload/loader.ts` - watch for file changes (optional)          | [x]    |
| 3.1.8 | Create example workload YAML files            | `config/workloads/examples/` - python-worker.yaml, node-api.yaml, etc.         | [x]    |
| 3.1.9 | Document YAML workload format                 | `docs/workload-spec.md` (new) - schema reference and examples                  | [x]    |

#### SyncSpec YAML Migration

**SIMPLIFIED**: Sync configuration is embedded in WorkloadSpec, not separate files. Tasks 3.1.10-3.1.19 are N/A.

| #      | Task                                          | Files Affected                                                                 | Status |
|--------|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 3.1.10 | ~~Define YAML schema for SyncSpec~~           | N/A - sync config is embedded in WorkloadSpec                                  | [N/A]  |
| 3.1.11 | ~~Create sync config directory~~              | N/A - no separate sync directory needed                                        | [N/A]  |
| 3.1.12 | ~~Add BOILERHOUSE_SYNC_DIR env var~~          | N/A - sync config comes from workload files                                    | [N/A]  |
| 3.1.13 | ~~Create file-backed SyncRegistry~~           | N/A - SyncCoordinator reads from WorkloadSpec.sync directly                    | [N/A]  |
| 3.1.14 | ~~Add YAML write-back on register()~~         | N/A                                                                            | [N/A]  |
| 3.1.15 | ~~Add YAML write-back on update()~~           | N/A                                                                            | [N/A]  |
| 3.1.16 | ~~Add YAML deletion on remove()~~             | N/A                                                                            | [N/A]  |
| 3.1.17 | ~~Add file watcher for external changes~~     | N/A                                                                            | [N/A]  |
| 3.1.18 | ~~Create example sync YAML files~~            | N/A - see workload examples with sync config                                   | [N/A]  |
| 3.1.19 | ~~Document YAML sync format~~                 | Sync config documented in `docs/workload-spec.md`                              | [x]    |

**Field mapping to docker-compose**:

| Boilerhouse Field | Docker Compose Equivalent | Notes                                    |
|-------------------|---------------------------|------------------------------------------|
| `image`           | `image`                   | Identical                                |
| `volumes`         | `volumes` (long syntax)   | Uses `target`, `read_only`               |
| `environment`     | `environment`             | Map or list format supported             |
| `healthcheck`     | `healthcheck`             | Uses `test`, `interval`, `timeout`, etc. |
| `deploy.resources`| `deploy.resources.limits` | Uses `cpus`, `memory`                    |
| `read_only`       | `read_only`               | Root filesystem read-only                |
| `user`            | `user`                    | UID to run as                            |
| `cap_drop`        | `cap_drop`                | Capabilities to drop                     |
| `network_mode`    | `network_mode`            | Network mode                             |

**Example workload YAML format** (docker-compose aligned):

```yaml
# config/workloads/python-worker.yaml
# Boilerhouse workload spec - follows docker-compose conventions

x-boilerhouse:
  id: python-worker
  name: Python ML Worker

image: myregistry/python-worker:latest

# Long-form volume syntax (docker-compose compatible)
# source is managed by boilerhouse based on x-boilerhouse-role
volumes:
  - target: /state
    read_only: false
    x-boilerhouse-role: state
  - target: /secrets
    read_only: true
    x-boilerhouse-role: secrets
  - target: /comm
    read_only: false
    x-boilerhouse-role: comm

environment:
  STATE_DIR: /state
  SECRETS_DIR: /secrets
  SOCKET_PATH: /comm/app.sock
  LOG_LEVEL: info

# docker-compose healthcheck format
healthcheck:
  test: ["CMD", "python", "-c", "print('ok')"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s

# docker-compose deploy.resources format
deploy:
  resources:
    limits:
      cpus: "2"
      memory: 1024M
    reservations:
      cpus: "0.5"
      memory: 256M

# docker-compose security options
read_only: true
user: "1000"
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
network_mode: bridge
```

**Boilerhouse extensions** use the `x-` prefix (docker-compose extension mechanism):
- `x-boilerhouse.id` - workload identifier (required)
- `x-boilerhouse.name` - human-readable name
- `x-boilerhouse-role` on volumes - volume role (state/secrets/comm)
- `x-boilerhouse.config_schema` - JSON Schema for tenant config validation

**Example SyncSpec YAML format**:

```yaml
# config/sync/ml-training-sync.yaml
# Boilerhouse sync spec - defines what/where/when to sync

id: ml-training-sync
pool_id: ml-gpu-pool

mappings:
  # Checkpoints - bidirectional, restore on claim, save on release
  - container_path: /data/checkpoints
    pattern: "*.pt"
    sink_path: checkpoints/
    direction: bidirectional
    mode: sync

  # Logs - upload only, periodic
  - container_path: /data/logs
    pattern: "**/*.log"
    sink_path: logs/
    direction: upload
    mode: copy    # Don't delete old logs from S3

  # Config - download only on claim
  - container_path: /config
    sink_path: config/
    direction: download
    mode: sync

sink:
  type: s3
  bucket: my-ml-data
  region: us-west-2
  prefix: workloads/ml/${tenantId}/   # Interpolated per-tenant
  # credentials via env vars or IAM role

policy:
  on_claim: true       # Restore state when tenant claims container
  on_release: true     # Save state when tenant releases container
  interval: 5m         # Also sync every 5 minutes while running
  allow_manual_trigger: true
```

**File-backed registry behavior**:
- On startup: load all `*.yaml` files from `config/sync/`
- On API `POST /sync-specs`: validate, register in memory, write to `config/sync/{id}.yaml`
- On API `PUT /sync-specs/:id`: validate, update in memory, overwrite YAML file
- On API `DELETE /sync-specs/:id`: remove from memory, delete YAML file
- Optional: watch directory for external changes and reload

---

### Phase 4: Docker Configuration ✅

| #   | Task                                | Status |
|-----|-------------------------------------|--------|
| 4.1 | Default docker image config         | [x]    |
| 4.2 | docker-compose.yml configuration    | [x]    |

### Phase 5: Tests ✅

| #   | Task                                          | Status |
|-----|-----------------------------------------------|--------|
| 5.1 | Docker integration tests                      | [x]    |
| 5.2 | Container unit tests                          | [x]    |
| 5.3 | Sync coordinator unit tests                   | [x]    |
| 5.4 | Generic workload test fixtures                | [x]    |

### Phase 6: Documentation ✅

| #   | Task                              | Status |
|-----|-----------------------------------|--------|
| 6.1 | README.md                         | [x]    |
| 6.2 | CLAUDE.md                         | [x]    |
| 6.3 | docs/workload-spec.md             | [x]    |
| 6.4 | docs/plans/boilerhouse-architecture.md | [x] |
| 6.5 | docs/plans/durability.md          | [x]    |

### Phase 7: Extensibility ✅

| #   | Task                              | Status |
|-----|-----------------------------------|--------|
| 7.1 | SinkAdapter interface             | [x]    |
| 7.2 | SinkAdapterRegistry               | [x]    |
| 7.3 | S3 sink adapter                   | [x]    |

### Phase 8: Workload Registry ✅

| #   | Task                                    | Status |
|-----|-----------------------------------------|--------|
| 8.1 | WorkloadRegistry with YAML file backing | [x]    |
| 8.2 | Zod schema validation                   | [x]    |
| 8.3 | Example workload YAML definitions       | [x]    |
| 8.4 | ContainerManager WorkloadSpec support   | [x]    |
| 8.5 | ContainerPool multi-workload support    | [x]    |

### Phase 9: Implement Sync API Endpoints

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 9.1 | POST /sync-specs - create sync spec           | N/A - sync specs are embedded in workloads                                     | [N/A]  |
| 9.2 | GET /sync-specs - list sync specs             | `apps/api/src/server.ts`                                                       | [x]    |
| 9.3 | GET /sync-specs/:id - get sync spec           | `apps/api/src/server.ts`                                                       | [x]    |
| 9.4 | PUT /sync-specs/:id - update sync spec        | N/A - sync specs are read-only (modify workload YAML)                          | [N/A]  |
| 9.5 | DELETE /sync-specs/:id - delete sync spec     | N/A - sync specs are read-only (modify workload YAML)                          | [N/A]  |
| 9.6 | GET /sync-specs/:id/status - sync status      | `apps/api/src/server.ts`                                                       | [x]    |
| 9.7 | POST /sync-specs/:id/trigger - manual trigger | `apps/api/src/server.ts`                                                       | [x]    |
| 9.8 | POST /tenants/:id/sync - tenant sync trigger  | `apps/api/src/server.ts`                                                       | [x]    |
| 9.9 | Add sync status to tenant status endpoint     | `apps/api/src/server.ts` (GET /tenants/:id/status)                             | [x]    |

**Note**: Phase 9 implemented with Elysia server in `apps/api/src/server.ts`. Sync specs are derived from WorkloadSpec.sync and are read-only via the API. To modify sync configuration, edit the workload YAML files in `config/workloads/`.

### Phase 10: Dashboard UI

| #    | Task                                          | Files Affected                                                                 | Status |
|------|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 10.1 | Set up Vite + React + TypeScript              | `apps/dashboard/` (package.json, vite.config.ts, tsconfig.json)                | [x]    |
| 10.2 | Add Tailwind CSS + shadcn/ui components       | `apps/dashboard/` (tailwind.config.js, src/components/ui/)                     | [x]    |
| 10.3 | Create API client with typed methods          | `apps/dashboard/src/api/` (client.ts, types.ts)                                | [x]    |
| 10.4 | Add TanStack Query hooks                      | `apps/dashboard/src/hooks/useApi.ts`                                           | [x]    |
| 10.5 | Create WebSocket hook for real-time updates   | `apps/dashboard/src/hooks/useWebSocket.ts`                                     | [x]    |
| 10.6 | Implement layout components                   | `apps/dashboard/src/components/layout/` (Sidebar, Header, Layout)              | [x]    |
| 10.7 | Implement Overview Dashboard page             | `apps/dashboard/src/pages/Dashboard.tsx`                                       | [x]    |
| 10.8 | Implement Pools list page                     | `apps/dashboard/src/pages/Pools.tsx`                                           | [x]    |
| 10.9 | Implement Pool detail page                    | `apps/dashboard/src/pages/PoolDetail.tsx`                                      | [x]    |
| 10.10| Implement Containers page                     | `apps/dashboard/src/pages/Containers.tsx`                                      | [x]    |
| 10.11| Implement Tenants list page                   | `apps/dashboard/src/pages/Tenants.tsx`                                         | [x]    |
| 10.12| Implement Tenant detail page                  | `apps/dashboard/src/pages/TenantDetail.tsx`                                    | [x]    |
| 10.13| Implement Sync monitor page                   | `apps/dashboard/src/pages/Sync.tsx`                                            | [x]    |
| 10.14| Implement Activity log page                   | `apps/dashboard/src/pages/Activity.tsx`                                        | [x]    |
| 10.15| Implement Settings page                       | `apps/dashboard/src/pages/Settings.tsx`                                        | [x]    |
| 10.16| Add mock data for development                 | `apps/dashboard/src/mocks/data.ts`                                             | [x]    |

**Note**: Dashboard now uses real API with fallback to mock data. WebSocket server implementation pending.

---

### Summary of Key Files

| File                                           | Description                               |
|------------------------------------------------|-------------------------------------------|
| `packages/core/src/types.ts`                   | Core TypeScript types                     |
| `packages/core/src/runtime.ts`                 | ContainerRuntime interface                |
| `packages/core/src/schemas/workload.ts`        | Zod schema for WorkloadSpec validation    |
| `packages/docker/src/docker-runtime.ts`        | Docker implementation                     |
| `apps/api/lib/config.ts`                       | Configuration and env vars                |
| `apps/api/lib/container/manager.ts`            | Container lifecycle management            |
| `apps/api/lib/container/pool.ts`               | Container pool with generic-pool          |
| `apps/api/lib/sync/registry.ts`                | SyncSpec registry                         |
| `apps/api/lib/sync/rclone.ts`                  | rclone sync executor                      |
| `apps/api/lib/sync/coordinator.ts`             | Sync lifecycle coordination               |
| `apps/api/lib/sync/status.ts`                  | Sync status tracking                      |
| `apps/api/lib/workload/loader.ts`              | YAML workload loader                      |
| `apps/api/src/server.ts`                       | Elysia API server                         |
| `apps/api/lib/activity/index.ts`               | Activity log module                       |
| `apps/api/lib/pool/registry.ts`                | Pool registry                             |
| `apps/dashboard/`                              | React dashboard application               |
| `config/workloads/*.yaml`                      | Workload definitions                      |
| `docs/workload-spec.md`                        | Workload YAML reference                   |

---

### Implementation Status

All core phases are complete:
- ✅ Phase 0: Project setup
- ✅ Phase 1: Core types
- ✅ Phase 2: Container configuration
- ✅ Phase 3: Sync engine
- ✅ Phase 3.1: YAML configuration
- ✅ Phase 4: Docker configuration
- ✅ Phase 5: Tests
- ✅ Phase 6: Documentation
- ✅ Phase 7: Extensibility
- ✅ Phase 8: Workload registry
- ✅ Phase 9: Sync API
- ✅ Phase 10: Dashboard UI
