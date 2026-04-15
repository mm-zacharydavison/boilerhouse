# Architecture

Boilerhouse is organized as a monorepo with shared domain logic that powers both the standalone API server and the Kubernetes operator.

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                   Entry Points                       │
│  ┌─────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │ API     │  │ CLI        │  │ K8s Operator     │  │
│  │ Server  │  │            │  │                  │  │
│  └────┬────┘  └─────┬──────┘  └────────┬─────────┘  │
│       │             │                  │             │
│  ┌────▼─────────────▼──────────────────▼──────────┐  │
│  │              Domain Layer                       │  │
│  │  TenantManager · InstanceManager · PoolManager  │  │
│  │  IdleMonitor · TenantDataStore · EventBus       │  │
│  └────────────────────┬───────────────────────────┘  │
│                       │                              │
│  ┌────────────────────▼───────────────────────────┐  │
│  │            Runtime Abstraction                  │  │
│  │  ┌──────────────┐  ┌────────────────────────┐  │  │
│  │  │ DockerRuntime │  │ KubernetesRuntime      │  │  │
│  │  └──────────────┘  └────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │           Supporting Packages                   │  │
│  │  Storage · Triggers · EnvoyConfig · O11y · DB   │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Monorepo Structure

```
boilerhouse/
├── apps/
│   ├── api/              # HTTP API server (Elysia.js)
│   ├── cli/              # CLI binary (Commander.js)
│   ├── dashboard/        # Web UI
│   ├── operator/         # Kubernetes operator
│   ├── trigger-gateway/  # Webhook ingress gateway
│   └── docs/             # This documentation site
├── packages/
│   ├── core/             # Types, workload schema, state machines
│   ├── domain/           # Business logic (managers, monitors)
│   ├── db/               # Database schema (Drizzle ORM + SQLite)
│   ├── runtime-docker/   # Docker runtime implementation
│   ├── k8s/              # Kubernetes client library
│   ├── triggers/         # Trigger adapters and dispatcher
│   ├── storage/          # Blob storage (disk, S3, encrypted)
│   ├── envoy-config/     # Envoy sidecar proxy configuration
│   ├── o11y/             # Observability (metrics, tracing, logging)
│   ├── guard-allowlist/  # Static tenant allowlist guard
│   ├── guard-api/        # HTTP-based access control guard
│   ├── driver-claude-code/ # Claude Code protocol driver
│   ├── driver-openclaw/  # OpenClaw protocol driver
│   └── driver-pi/        # Pi protocol driver
├── workloads/            # Example workload definitions
└── tests/
    ├── integration/      # Docker & Kubernetes integration tests
    ├── e2e/              # End-to-end tests (all runtimes)
    ├── e2e-operator/     # Operator-specific E2E tests
    └── security/         # Security scans (Nuclei, CDK)
```

## Core Components

### Domain Layer

The domain layer (`packages/domain`) contains all business logic. It is runtime-agnostic — the same code runs whether you're using Docker or Kubernetes.

| Manager | Responsibility |
|---------|----------------|
| **TenantManager** | Orchestrates claim and release. Decides between fast path, pool path, and cold boot. Extracts and restores overlays. |
| **InstanceManager** | Creates, starts, destroys, and hibernates container instances. Wraps the runtime abstraction. |
| **PoolManager** | Manages pre-warmed instance pools. Handles health checks, acquisition, replenishment, and draining. |
| **IdleMonitor** | Tracks per-instance idle timeouts. Fires callbacks when instances go idle. |
| **TenantDataStore** | Persists and restores tenant filesystem overlays to blob storage (disk or S3). |
| **AuditLogger** | Records lifecycle events to the activity log table. |
| **EventBus** | Publishes domain events for real-time WebSocket streaming and metrics instrumentation. |

### Runtime Abstraction

The `Runtime` interface (`packages/core`) defines how Boilerhouse interacts with container runtimes:

```typescript
interface Runtime {
  create(workload, instanceId, options?): Promise<InstanceHandle>
  start(handle): Promise<void>
  destroy(handle): Promise<void>
  exec(handle, command): Promise<ExecResult>
  getEndpoint(handle): Promise<Endpoint>
  list(): Promise<InstanceId[]>

  // Optional capabilities
  logs?(handle, tail?): Promise<string | null>
  injectArchive?(instanceId, destPath, tar): Promise<void>
  extractOverlayArchive?(instanceId, dirs): Promise<Buffer>
  pause?(handle): Promise<void>
  unpause?(handle): Promise<void>
}
```

Two implementations exist:
- **DockerRuntime** (`packages/runtime-docker`) — manages containers via the Docker daemon socket
- **KubernetesRuntime** (`apps/operator`) — manages Pods, Services, and NetworkPolicies via the K8s API

### Database

Boilerhouse uses SQLite via Drizzle ORM (`packages/db`). Key tables:

| Table | Purpose |
|-------|---------|
| `workloads` | Registered workload definitions and their status |
| `instances` | Running container instances with status and runtime metadata |
| `tenants` | Tenant identity rows with last snapshot references |
| `claims` | Active tenant-instance bindings |
| `snapshots` | Persisted overlay snapshots (golden and tenant types) |
| `triggers` | Trigger definitions (webhook, Slack, Telegram, cron) |
| `activity_log` | Persistent audit trail of lifecycle events |
| `nodes` | Registered runtime nodes with capacity info |
| `tenant_secrets` | Encrypted per-tenant secrets |

## Instance State Machine

Every instance moves through a defined state machine:

```
starting ──► active ──► hibernating ──► hibernated
                │                          │
                │                          ▼
                │                      (next claim) ──► starting
                │
                └──► destroying ──► destroyed
```

| Status | Description |
|--------|-------------|
| `starting` | Container is being created and started |
| `active` | Container is running and assigned to a tenant |
| `hibernating` | Overlay is being extracted, container shutting down |
| `hibernated` | Container destroyed, overlay saved to storage |
| `destroying` | Container is being torn down |
| `destroyed` | Container fully removed |

## Request Lifecycle

A tenant claim request follows this path:

```
POST /tenants/:id/claim
        │
        ▼
  Has existing active claim? ──► Yes ──► Return existing (fast path)
        │
       No
        │
        ▼
  Has previous overlay data?
        │
       Yes ──► Cold boot + inject overlay (cold+data)
        │
       No
        │
        ▼
  Pool available? ──► Yes ──► Acquire from pool
        │                        │
        │                  Has overlay? ──► Inject overlay (pool+data)
        │                        │
        │                       No ──► Return (pool)
       No
        │
        ▼
  Cold boot new instance (cold)
        │
        ▼
  Start idle monitor
  Return endpoint
```

## Data Flow

```
Tenant Claims ──► TenantManager ──► InstanceManager ──► Runtime (Docker/K8s)
                       │                    │
                       │                    ├──► Container created
                       │                    ├──► Health checks pass
                       │                    └──► Endpoint returned
                       │
                       ├──► TenantDataStore ──► BlobStore (disk/S3)
                       │         │
                       │         ├──► Extract overlay on release
                       │         └──► Inject overlay on claim
                       │
                       ├──► IdleMonitor ──► Fires on timeout
                       │
                       └──► EventBus ──► WebSocket clients
                                    └──► Prometheus metrics
```
