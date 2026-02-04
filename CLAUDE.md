# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Boilerhouse is a multi-tenant container pool orchestrator that pre-warms Docker containers for fast assignment to tenants. It provides isolation between tenants through volume wiping on release and supports state sync to remote storage via rclone.

## Commands

```bash
# Development
bun run dev                    # Start API server with watch mode
bun run dev:dashboard          # Start dashboard with watch mode

# Build
bun run build                  # Build all packages and apps

# Testing
bun test                       # Run all tests
bun test apps/api/lib/container/container.unit.test.ts  # Run a single test file
bun test --match "ContainerPool"                        # Run tests matching pattern

# Type checking
bun run typecheck              # Type check all packages

# Linting
bun run lint                   # Check for lint errors
bun run lint:fix               # Auto-fix lint errors
bun run format                 # Format code with Biome
```

## Architecture

### Monorepo Structure

This is a Bun workspace monorepo with:
- `apps/` - Deployable applications
- `packages/` - Shared libraries

### Key Packages

**@boilerhouse/core** (`packages/core/`)
- Shared TypeScript types and interfaces
- `ContainerRuntime` interface - abstraction for container backends
- Domain types: `TenantId`, `ContainerId`, `PoolId`, `WorkloadSpec`, `PoolSpec`, `SyncSpec`
- Default security and network configurations

**@boilerhouse/docker** (`packages/docker/`)
- `DockerRuntime` - implements `ContainerRuntime` using dockerode
- Handles Docker-specific container operations

**@boilerhouse/api** (`apps/api/`)
- Main API server (Elysia)
- `ContainerManager` (`lib/container/manager.ts`) - manages container lifecycle, creates host directories, assigns containers to tenants
- `ContainerPool` (`lib/container/pool.ts`) - uses generic-pool to maintain pre-warmed containers
- Sync module (`lib/sync/`) - rclone-based state synchronization to S3
- Configuration via environment variables (`lib/config.ts`)

### Container Lifecycle

1. Pool maintains `minPoolSize` idle containers pre-warmed
2. `acquireForTenant(tenantId)` - assigns idle container to tenant
3. Container runs with tenant's workload
4. `releaseForTenant(tenantId)` - wipes state/secrets directories, returns to pool
5. Container recycled for next tenant

### Runtime Abstraction

The `ContainerRuntime` interface allows swapping container backends:
```typescript
interface ContainerRuntime {
  createContainer(spec: ContainerSpec): Promise<ContainerInfo>
  destroyContainer(id: RuntimeContainerId): Promise<void>
  isHealthy(id: RuntimeContainerId): Promise<boolean>
  // ... other methods
}
```

Currently implemented: `DockerRuntime`. Designed for future Kubernetes support.

### State Sync Engine

The sync module (`apps/api/lib/sync/`) provides rclone-based state synchronization:

- `SyncRegistry` - in-memory store for `SyncSpec` configurations
- `RcloneSyncExecutor` - executes rclone commands for upload/download/bidirectional sync
- `SyncCoordinator` - orchestrates sync lifecycle (onClaim, onRelease, periodic)
- `SyncStatusTracker` - tracks sync status per tenant (lastSync, pending, errors)
- `SinkAdapter` interface - abstracts sink-specific rclone configuration
- `SinkAdapterRegistry` - registry for sink adapters (S3 built-in, extensible for GCS, Azure, etc.)

Sync lifecycle:
1. `onClaim` - downloads state from sink when tenant claims container
2. `periodic` - uploads state at configured intervals while container is active
3. `onRelease` - uploads final state when tenant releases container

#### Adding New Sink Types

To add a new sink type (e.g., GCS):
1. Add type definition to `packages/core/src/types.ts` (e.g., `GCSSinkConfig`)
2. Create adapter implementing `SinkAdapter` in `apps/api/lib/sync/sink-adapter.ts`
3. Register adapter in `SinkAdapterRegistry`

## Code Patterns

### TypeScript Path Aliases

```typescript
import { type TenantId, type WorkloadSpec } from '@boilerhouse/core'
import { DockerRuntime } from '@boilerhouse/docker'
```

### Testing with Mocked Runtime

Tests use a mock `ContainerRuntime` to avoid Docker dependency:
```typescript
function createMockRuntime(): ContainerRuntime {
  return {
    name: 'mock',
    createContainer: mock(async (spec) => ({ ... })),
    // ...
  }
}
```

### Environment Variables

Configuration in `apps/api/lib/config.ts`:
- `BOILERHOUSE_POOL_SIZE` - minimum idle containers (default: 5)
- `BOILERHOUSE_MAX_CONTAINERS` - max containers per node (default: 50)
- `BOILERHOUSE_DEFAULT_IMAGE` - container image for default workload

## Linting

Uses Biome with:
- `noExplicitAny: "error"` - avoid `any` type
- Single quotes, no semicolons
- 2-space indentation, 100 char line width
