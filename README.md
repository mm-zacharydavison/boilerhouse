# Boilerhouse

Generic container pool orchestrator for managing pre-warmed container pools with tenant isolation and state synchronization.

## Overview

Boilerhouse provides:

- **Container Pooling** - Maintain pools of pre-warmed containers for fast assignment
- **Tenant Isolation** - Each tenant gets isolated state and secrets directories
- **Workload Specs** - Define container configurations via WorkloadSpec
- **State Sync** - Synchronize state to/from external storage via rclone (S3, etc.)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Boilerhouse API                                 │
│  POST /tenants/:tenantId/claim   - Claim container from pool            │
│  POST /tenants/:tenantId/release - Release container back to pool       │
│  GET  /tenants/:tenantId/status  - Get tenant status                    │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼───────────────────────────────────┐
│                   Container Manager │                                    │
│  - Creates containers from WorkloadSpec                                  │
│  - Manages state/secrets volumes                                         │
│  - Tracks tenant assignments                                             │
└─────────────────────────────────────┼───────────────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────────────┐
          │    Container Pool (per WorkloadSpec)                          │
          │  ┌───────────┐  ┌───────────┐  ┌───────────┐                  │
          │  │ Tenant A  │  │ Tenant B  │  │ (idle)    │                  │
          │  │ /state    │  │ /state    │  │           │                  │
          │  │ /secrets  │  │ /secrets  │  │           │                  │
          │  └───────────┘  └───────────┘  └───────────┘                  │
          └───────────────────────────────────────────────────────────────┘
```

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- Docker

## Setup

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Or use Docker Compose
docker compose up
```

## Development

```bash
# Type checking
bun run typecheck

# Linting
bun run lint

# Format code
bun run format

# Run tests
bun test

# Run integration tests (requires Docker)
INTEGRATION_TESTS=1 bun test
```

## Configuration

Environment variables:

| Variable                        | Default                         | Description                     |
|---------------------------------|---------------------------------|---------------------------------|
| `BOILERHOUSE_API_PORT`          | `3000`                          | API server port                 |
| `BOILERHOUSE_API_HOST`          | `0.0.0.0`                       | API server host                 |
| `BOILERHOUSE_POOL_SIZE`         | `5`                             | Pre-warmed container pool size  |
| `BOILERHOUSE_MAX_CONTAINERS`    | `50`                            | Max containers per node         |
| `BOILERHOUSE_IDLE_TIMEOUT_MS`   | `300000`                        | Container idle timeout (5 min)  |
| `BOILERHOUSE_STATE_DIR`         | `/var/lib/boilerhouse/states`   | Base dir for tenant state       |
| `BOILERHOUSE_SECRETS_DIR`       | `/var/lib/boilerhouse/secrets`  | Base dir for tenant secrets     |
| `BOILERHOUSE_SOCKET_DIR`        | `/var/run/boilerhouse`          | Base dir for Unix sockets       |
| `BOILERHOUSE_DEFAULT_IMAGE`     | `alpine:latest`                 | Default container image         |

## Workload Specification

Define your container configuration via `WorkloadSpec`:

```typescript
const myWorkload: WorkloadSpec = {
  id: 'my-worker' as WorkloadId,
  name: 'My Worker',
  image: 'myregistry/my-worker:latest',
  volumes: {
    state: { containerPath: '/data', mode: 'rw' },
    secrets: { containerPath: '/secrets', mode: 'ro' },
    comm: { containerPath: '/comm', mode: 'rw' },
  },
  environment: {
    DATA_DIR: '/data',
    LOG_LEVEL: 'info',
  },
  healthCheck: {
    command: ['curl', '-f', 'http://localhost:8080/health'],
    intervalMs: 30000,
    timeoutMs: 5000,
    retries: 3,
  },
}
```

## Security

Boilerhouse provides strong isolation between tenants:

- **Filesystem**: Each container only sees its own `/state` and `/secrets`
- **Security Options**: Read-only root filesystem, dropped capabilities, no privilege escalation
- **Resources**: CPU, memory, and tmpfs quotas enforced

## License

MIT
