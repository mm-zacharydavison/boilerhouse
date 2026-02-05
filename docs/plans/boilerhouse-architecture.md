# Generic Multiclaw: Container Pool Orchestrator

## Overview

Transform multiclaw from an OpenClaw-specific orchestrator into a generic container pooling platform that can manage any containerized workload with configurable state synchronization.

## Goals

1. **Generic Container Pooling**: Provision and manage warm pools of any container image
2. **Tenant Isolation**: Claim containers for users with isolated state/secrets
3. **Bidirectional State Sync**: Sync state to external sinks (S3, etc.) and restore into containers
4. **Monitoring Dashboard**: Real-time visibility into pool status, container health, and sync state

---

## Current State Analysis

### Already Generic

| Component            | Location                              | Status                                    |
|----------------------|---------------------------------------|-------------------------------------------|
| ContainerRuntime     | `packages/core/src/runtime.ts`        | Abstract interface, Docker/K8s ready      |
| ContainerManager     | `apps/api/lib/container/manager.ts`   | Lifecycle management, mostly generic      |
| ContainerPool        | `apps/api/lib/container/pool.ts`      | Pre-warmed pool with generic-pool         |
| DockerRuntime        | `packages/docker/src/docker-runtime.ts` | Clean implementation of runtime interface |
| Security Model       | Hardcoded in manager                  | Read-only root, dropped caps, non-root    |

### OpenClaw-Specific (Needs Abstraction)

> TODO: All this should be removed for boilerhouse. We don't need any openclaw specific things, our plan will be to implement multiclaw using boilerhouse later.

| Component              | Current State                              | Required Change                           |
|------------------------|--------------------------------------------|-------------------------------------------|
| TenantState.config     | `OpenClawConfig` interface                 | Generic JSON with schema validation       |
| Volume mounts          | Hardcoded `/state`, `/secrets`, `/comm`    | Configurable per workload                 |
| Environment variables  | `OPENCLAW_*` vars                          | Configurable per workload                 |
| Health check           | `openclaw --version`                       | Configurable command per workload         |
| Network name           | `'multiclaw-egress'`                       | Configurable                              |
| State file structure   | `openclaw.json`, `sessions/*.jsonl`        | Configurable per workload                 |
| Fluent Bit config      | Assumes OpenClaw transcript paths          | Templated per workload                    |

---

## Architecture

### Core Concepts

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Multiclaw API                               │
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
│  Multiclaw Dashboard                              [Settings] [?] │
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
│  │ prod-agents  │ openclaw    │  20 / 25   │   18    │   ●    │ │
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

### Phase 1: Core Abstraction (Foundation)

**Goal**: Decouple from OpenClaw specifics, introduce workload concept

1. **Define new types** in `packages/core/src/types.ts`
   - `WorkloadSpec`, `PoolSpec`, `SyncSpec`
   - `TenantAssignment` (replaces OpenClaw-specific tenant types)
   - `SinkConfig` union type

2. **Create WorkloadRegistry** in `apps/api/lib/workload/`
   - In-memory store (later: persistent)
   - CRUD operations for workload specs
   - JSON Schema validation for configs

3. **Refactor ContainerManager**
   - Accept `WorkloadSpec` in `createContainer()`
   - Parameterize volume mounts, env vars, health checks
   - Remove hardcoded OpenClaw references

4. **Refactor ContainerPool**
   - Associate pools with workload specs
   - Support multiple pools per workload
   - Parameterize pool configuration

5. **Update StateProvisioner**
   - Accept generic config (validated against schema)
   - Configurable file paths and names
   - Remove OpenClaw-specific file structure

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

## Migration Path (OpenClaw)

To maintain backward compatibility during transition:

1. **Create OpenClaw workload spec** as default:
   ```typescript
   const openclawWorkload: WorkloadSpec = {
     id: 'openclaw' as WorkloadId,
     name: 'OpenClaw Agent',
     image: 'multiclaw-openclaw:latest',
     volumes: {
       state: { containerPath: '/state', mode: 'rw' },
       secrets: { containerPath: '/secrets', mode: 'ro' },
       comm: { containerPath: '/comm', mode: 'rw' },
     },
     environment: {
       OPENCLAW_STATE_DIR: '/state',
       OPENCLAW_SOCKET: '/comm/openclaw.sock',
       NODE_ENV: 'production',
     },
     healthCheck: {
       command: ['openclaw', '--version'],
       intervalMs: 30000,
       timeoutMs: 5000,
       retries: 3,
     },
     configSchema: openclawConfigSchema,  // Existing schema
   }
   ```

2. **Auto-register on startup** if no workloads exist

3. **Existing tests continue to work** against OpenClaw workload

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
│   │   │   └── defaults.ts       # Built-in workloads (OpenClaw)
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

## Task List: Boilerhouse Transformation

This section tracks the work required to transform this project from an OpenClaw-specific orchestrator into a generic container pool management system called "Boilerhouse".

### Phase 0: Project Renaming (multiclaw → boilerhouse)

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 0.1 | Rename root package                           | `package.json` (name: multiclaw → boilerhouse)                                 | [x]    |
| 0.2 | Rename core package                           | `packages/core/package.json` (@multiclaw/core → @boilerhouse/core)             | [x]    |
| 0.3 | Rename docker package                         | `packages/docker/package.json` (@multiclaw/docker → @boilerhouse/docker)       | [x]    |
| 0.4 | Rename api package                            | `apps/api/package.json` (@multiclaw/api → @boilerhouse/api)                    | [x]    |
| 0.5 | Update all import statements                  | All .ts files importing @multiclaw/*                                           | [x]    |
| 0.6 | Rename `MulticlawConfig` type                 | `packages/core/src/types.ts`                                                   | [x]    |
| 0.7 | Update environment variable prefix            | `apps/api/lib/config.ts` (MULTICLAW_* → BOILERHOUSE_*)                         | [x]    |
| 0.8 | Update docker-compose volume names            | `docker-compose.yml` (multiclaw-states → boilerhouse-states, etc.)             | [x]    |
| 0.9 | Update docker-compose network names           | `docker-compose.yml` (multiclaw-internal → boilerhouse-internal, etc.)         | [x]    |
| 0.10| Update network name in manager                | `apps/api/lib/container/manager.ts` (multiclaw-egress → boilerhouse-egress)    | [x]    |
| 0.11| Update container label prefix                 | `apps/api/lib/container/manager.ts` (multiclaw → boilerhouse)                  | [x]    |
| 0.12| Update host directory paths                   | `apps/api/lib/config.ts` (/var/lib/multiclaw → /var/lib/boilerhouse)           | [x]    |
| 0.13| Update console log messages                   | `apps/api/src/index.ts`                                                        | [x]    |

### Phase 1: Remove OpenClaw-Specific Types & Interfaces

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 1.1 | Remove/rename `OpenClawContainer` interface   | `packages/core/src/types.ts` → generic `PoolContainer`                         | [x]    |
| 1.2 | Remove/rename `OpenClawConfig` interface      | `packages/core/src/types.ts` → generic `WorkloadConfig` or remove              | [x]    |
| 1.3 | Add `WorkloadSpec` interface                  | `packages/core/src/types.ts` (as defined in this plan)                         | [x]    |
| 1.4 | Add `PoolSpec` interface                      | `packages/core/src/types.ts`                                                   | [x]    |
| 1.5 | Add `SyncSpec` interface                      | `packages/core/src/types.ts`                                                   | [x]    |
| 1.6 | Add `SinkConfig` union type                   | `packages/core/src/types.ts`                                                   | [x]    |
| 1.7 | Add `TenantAssignment` interface              | `packages/core/src/types.ts`                                                   | [x]    |
| 1.8 | Remove plugin-specific types                  | `packages/core/src/types.ts` (multiclaw-tools references)                      | [x]    |
| 1.9 | Update all type imports in consuming files    | All files importing from @boilerhouse/core                                     | [x]    |

### Phase 2: Abstract Hardcoded Container Configuration

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 2.1 | Remove hardcoded volume paths                 | `apps/api/lib/container/manager.ts` (/state, /secrets, /comm)                  | [x]    |
| 2.2 | Make volume mounts configurable via WorkloadSpec | `apps/api/lib/container/manager.ts`                                         | [x]    |
| 2.3 | Remove OPENCLAW_* environment variables       | `apps/api/lib/container/manager.ts`                                            | [x]    |
| 2.4 | Make environment variables configurable       | `apps/api/lib/container/manager.ts` (use WorkloadSpec.environment)             | [x]    |
| 2.5 | Remove hardcoded health check                 | `apps/api/lib/container/manager.ts` (openclaw --version)                       | [x]    |
| 2.6 | Make health check configurable                | `apps/api/lib/container/manager.ts` (use WorkloadSpec.healthCheck)             | [x]    |
| 2.7 | Remove openclaw.sock naming                   | `apps/api/lib/container/manager.ts` → generic socket naming                    | [x]    |
| 2.8 | Rename container prefix                       | `apps/api/lib/container/manager.ts` (openclaw-${id} → container-${id})         | [x]    |
| 2.9 | Make network mode configurable                | `apps/api/lib/container/manager.ts` (via WorkloadSpec.security)                | [x]    |

### Phase 3: Implement rclone-Based Sync Engine

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 3.1 | Define `SyncSpec` and `SyncMapping` types     | `packages/core/src/types.ts`                                                   | [x]    |
| 3.2 | Define `S3SinkConfig` type (v1 only)          | `packages/core/src/types.ts`                                                   | [x]    |
| 3.3 | Define `SyncPolicy` type                      | `packages/core/src/types.ts`                                                   | [x]    |
| 3.4 | Create SyncRegistry module                    | `apps/api/lib/sync/registry.ts` (new) - CRUD for SyncSpecs                     | [x]    |
| 3.5 | Create RcloneSyncExecutor                     | `apps/api/lib/sync/rclone.ts` (new)                                            | [x]    |
| 3.6 | Implement upload sync (container → S3)        | `apps/api/lib/sync/rclone.ts`                                                  | [x]    |
| 3.7 | Implement download sync (S3 → container)      | `apps/api/lib/sync/rclone.ts`                                                  | [x]    |
| 3.8 | Implement bidirectional sync                  | `apps/api/lib/sync/rclone.ts`                                                  | [x]    |
| 3.9 | Add glob pattern support to sync mappings     | `apps/api/lib/sync/rclone.ts` (--include flag)                                 | [x]    |
| 3.10| Create SyncCoordinator                        | `apps/api/lib/sync/coordinator.ts` (new)                                       | [x]    |
| 3.11| Implement onClaim sync hook                   | `apps/api/lib/sync/coordinator.ts` - download on container claim               | [x]    |
| 3.12| Implement onRelease sync hook                 | `apps/api/lib/sync/coordinator.ts` - upload on container release               | [x]    |
| 3.13| Implement periodic sync scheduler             | `apps/api/lib/sync/coordinator.ts` - intervalMs support                        | [x]    |
| 3.14| Add path interpolation (${tenantId})          | `apps/api/lib/sync/rclone.ts`                                                  | [x]    |
| 3.15| Add sync status tracking                      | `apps/api/lib/sync/status.ts` (new) - lastSync, pending, errors                | [x]    |
| 3.16| Remove OpenClaw-specific state files          | `apps/api/lib/state/` (openclaw.json, sessions/*.jsonl)                        | [N/A]  |
| 3.17| Remove Fluent Bit integration (defer to v2)   | `apps/api/lib/state/fluent-bit.ts` - remove or stub                            | [N/A]  |
| 3.18| Generalize secrets provisioner                | `apps/api/lib/state/secrets.ts`                                                | [N/A]  |

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

### Phase 4: Update Docker Artifacts

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 4.1 | Rename docker/openclaw directory              | `docker/openclaw/` → `docker/example-workload/` or remove                      | [N/A]  |
| 4.2 | Update Dockerfile                             | Remove OPENCLAW_* env vars, update paths                                       | [N/A]  |
| 4.3 | Update entrypoint.sh                          | Remove OpenClaw-specific logic                                                 | [N/A]  |
| 4.4 | Update state-sync.sh                          | Generalize or remove                                                           | [N/A]  |
| 4.5 | Update default docker image config            | `apps/api/lib/config.ts` (multiclaw-openclaw:latest → example)                 | [x]    |
| 4.6 | Update docker-compose.yml                     | Remove OpenClaw-specific service definitions                                   | [x]    |

**Note**: Tasks 4.1-4.4 marked N/A because docker/openclaw/ directory and related files (entrypoint.sh, state-sync.sh) never existed in this codebase. Task 4.5 completed via workload YAML system (Phase 3.1). Task 4.6 completed in Phase 0.

### Phase 5: Update Tests

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 5.1 | Update integration tests                      | `test/state.integration.test.ts` (remove OPENCLAW refs)                        | [ ]    |
| 5.2 | Update docker integration tests               | `test/docker.integration.test.ts` (update network names)                       | [ ]    |
| 5.3 | Update unit tests                             | `apps/api/lib/state/state.unit.test.ts`                                        | [ ]    |
| 5.4 | Create generic workload test fixture          | New test helper for creating test workload specs                               | [ ]    |

### Phase 6: Update Documentation

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 6.1 | Update root README.md                         | Complete rewrite for Boilerhouse                                               | [ ]    |
| 6.2 | Update CLAUDE.md                              | Project overview and architecture                                              | [ ]    |
| 6.3 | Update or remove TASKS.md                     | Remove OpenClaw-specific tasks                                                 | [ ]    |
| 6.4 | Archive OpenClaw plan documents               | `docs/plans/openclaw-mvp.md`, `openclaw-mvp-security-appendix.md`              | [ ]    |
| 6.5 | Rename this plan document                     | `generic-multiclaw.md` → `boilerhouse-architecture.md`                         | [ ]    |
| 6.6 | Update API documentation                      | Any API docs referencing OpenClaw endpoints                                    | [ ]    |

### Phase 7: Remove OpenClaw Plugins

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 7.1 | Remove or archive plugins directory           | `plugins/` directory                                                           | [N/A]  |
| 7.2 | Remove plugin references in types             | `packages/core/src/types.ts` (multiclaw-tools examples)                        | [x]    |
| 7.3 | Remove plugin copy from Dockerfile            | `docker/openclaw/Dockerfile` (commented COPY instruction)                      | [N/A]  |

**Note**: Tasks 7.1 and 7.3 marked N/A because plugins/ directory and docker/openclaw/Dockerfile never existed. Task 7.2 completed in Phase 1.

### Phase 8: Create Workload Registry (New Feature)

| #   | Task                                          | Files Affected                                                                 | Status |
|-----|-----------------------------------------------|--------------------------------------------------------------------------------|--------|
| 8.1 | Create workload registry module               | `apps/api/lib/workload/loader.ts` (implemented as loader with registry)        | [x]    |
| 8.2 | Add JSON Schema validation                    | `packages/core/src/schemas/workload.ts` (Zod schema with validation)           | [x]    |
| 8.3 | Create example workload definitions           | `config/workloads/examples/` (YAML files)                                      | [x]    |
| 8.4 | Update ContainerManager to use registry       | `apps/api/lib/container/manager.ts` (accepts WorkloadSpec)                     | [x]    |
| 8.5 | Update ContainerPool for multi-workload       | `apps/api/lib/container/pool.ts` (accepts workload in config)                  | [x]    |

**Note**: Phase 8 completed as part of Phase 3.1 (YAML migration). Workload registry implemented as `WorkloadRegistry` class in `loader.ts`.

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

### Summary of Changes by File

| File                                           | Changes Required                                      | Status |
|------------------------------------------------|-------------------------------------------------------|--------|
| `package.json`                                 | Rename to boilerhouse                                 | Done   |
| `packages/core/package.json`                   | Rename to @boilerhouse/core                           | Done   |
| `packages/docker/package.json`                 | Rename to @boilerhouse/docker                         | Done   |
| `apps/api/package.json`                        | Rename to @boilerhouse/api                            | Done   |
| `packages/core/src/types.ts`                   | Major refactor - rename/remove OpenClaw types         | Done   |
| `packages/core/src/runtime.ts`                 | Update examples in comments                           | Done   |
| `apps/api/lib/config.ts`                       | Rename env vars, update paths and image name          | Done   |
| `apps/api/lib/container/manager.ts`            | Major refactor - parameterize all OpenClaw specifics  | Done   |
| `apps/api/lib/container/pool.ts`               | Minor updates for new types                           | Done   |
| `apps/api/lib/sync/registry.ts`                | In-memory registry for SyncSpecs                      | Done   |
| `apps/api/lib/sync/rclone.ts`                  | Generic rclone executor                               | Done   |
| `apps/api/lib/sync/coordinator.ts`             | Sync lifecycle management                             | Done   |
| `apps/api/lib/sync/status.ts`                  | Sync status tracking                                  | Done   |
| `apps/api/lib/workload/loader.ts`              | YAML workload loader and validator                    | Done   |
| `packages/core/src/schemas/workload.ts`        | Zod schema for WorkloadSpec validation                | Done   |
| `config/workloads/*.yaml`                      | Workload definition files                             | Done   |
| `config/workloads/examples/*.yaml`             | Example workload files                                | Done   |
| `docs/workload-spec.md`                        | Workload YAML format documentation                    | Done   |
| `apps/api/src/index.ts`                        | Update log messages                                   | Done   |
| `docker-compose.yml`                           | Update all names and networks                         | Done   |
| `README.md`                                    | Complete rewrite                                      | Done   |
| `CLAUDE.md`                                    | Update project description                            | Done   |
| `apps/dashboard/`                              | New - React dashboard application                     | Done   |
| `apps/dashboard/src/api/`                      | API client and types                                  | Done   |
| `apps/dashboard/src/components/`               | UI components (layout, ui)                            | Done   |
| `apps/dashboard/src/pages/`                    | Dashboard pages                                       | Done   |
| `apps/dashboard/src/hooks/`                    | React hooks (useApi, useWebSocket)                    | Done   |
| `apps/api/src/server.ts`                       | Elysia API server (all routes)                        | Done   |
| `apps/api/lib/activity/index.ts`               | Activity log module                                   | Done   |
| `apps/api/lib/pool/registry.ts`                | Pool registry for multi-pool support                  | Done   |
| `test/*.ts`                                    | Update references                                     | TODO   |

---

### Execution Order Recommendation

1. **Phase 0** first - establishes new naming convention ✅ DONE
2. **Phase 1** next - defines the new type system (including SyncSpec, SinkConfig) ✅ DONE
3. **Phase 2** - core abstraction of container config ✅ DONE
4. **Phase 3** - rclone sync engine implementation (depends on Phase 1 types) ✅ DONE
5. **Phase 3.1** - migrate specs to YAML (WorkloadSpec + SyncSpec with file-backed registry) ✅ DONE
6. **Phase 4** - Docker cleanup ✅ DONE (mostly N/A)
7. **Phase 5** - ensure tests pass after each phase
8. **Phase 6** - documentation (can be done in parallel)
9. **Phase 7** - plugin removal ✅ DONE (mostly N/A)
10. **Phase 8** - workload registry feature (builds on Phase 3.1 YAML loader) ✅ DONE
11. **Phase 9** - sync API endpoints (depends on Phase 3 sync engine) ✅ DONE
12. **Phase 10** - dashboard UI ✅ DONE (with real API integration)
