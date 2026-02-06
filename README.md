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

Define workloads as YAML files in the workloads directory (default: `./workloads/`).

Workloads copy the `docker-compose` YAML format for the most part, with some extensions for `boilerhouse`.

```yaml
# workloads/my-worker.yaml

# Unique identifier for this workload (used in API calls)
id: my-worker

# Human-readable name
name: My Worker

# Container image to use
image: myregistry/my-worker:latest

# Volume mounts - boilerhouse manages these directories per-container
volumes:
  # State volume: persistent data that survives container restarts
  # Wiped when container is released back to pool (unless sync is configured)
  state:
    target: /data           # Mount path inside container

  # Secrets volume: tenant credentials, API keys, etc.
  # Always read-only inside the container for security
  secrets:
    target: /secrets
    read_only: true

# Environment variables passed to the container
environment:
  DATA_DIR: /data
  LOG_LEVEL: info
  NODE_ENV: production

# Optional: override the default entrypoint
# command: ["node", "dist/index.js", "serve"]

# Health check configuration (Docker-style)
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s            # Time between health checks
  timeout: 5s              # Max time for health check to complete
  retries: 3               # Failures before marking unhealthy
  start_period: 10s        # Grace period for container startup

# Optional: expose ports (for debugging or direct access)
# ports:
#   - container: 8080
#     protocol: tcp

# Resource limits
deploy:
  resources:
    limits:
      cpus: "2"            # Max CPU cores
      memory: 2G           # Max memory

# Security settings
read_only: false           # Set true for read-only root filesystem
user: "1000"               # Run as specific UID (non-root recommended)
network_mode: bridge       # Network mode for container

# Pool configuration for this workload
pool:
  min_size: 2              # Minimum idle containers to maintain
  max_size: 20             # Maximum containers for this workload
  idle_timeout: 10m        # How long idle containers stay warm

# State synchronization to remote storage (optional)
# Syncs tenant state to/from S3, GCS, or other rclone-supported backends
sync:
  # Sink configuration - where to store tenant state
  sink:
    type: s3               # Storage backend (s3, gcs, azure, etc.)
    bucket: my-bucket      # Bucket name
    region: us-east-1      # AWS region
    # For S3-compatible storage (MinIO, R2, etc.):
    # endpoint: http://minio:9000
    # access_key_id: minioadmin
    # secret_access_key: minioadmin

    # Prefix template - ${tenantId} is replaced with actual tenant ID
    prefix: tenants/${tenantId}/

    # Additional rclone flags (optional)
    # rclone_flags:
    #   - "--s3-force-path-style"    # Required for MinIO

  # What to sync - paths relative to the state volume
  mappings:
    # Sync the entire state directory
    - path: /
      direction: bidirectional  # upload and download
      mode: sync                # mirror changes (delete removed files)

    # Or sync specific subdirectories with different policies:
    # - path: credentials        # Critical data - sync bidirectionally
    #   direction: bidirectional
    #   mode: sync
    #
    # - path: cache              # Disposable - upload only for backup
    #   direction: upload
    #   mode: copy               # Don't delete remote files
    #
    # - path: config.json        # Single file sync
    #   direction: bidirectional
    #   mode: sync

  # When to trigger syncs
  policy:
    on_claim: true         # Download state when tenant claims container
    on_release: true       # Upload state when tenant releases container
    manual: true           # Allow manual sync via API
    # periodic: 5m         # Sync every 5 minutes while claimed (optional)
```

## Security

Boilerhouse provides strong isolation between tenants:

- **Filesystem**: Each container only sees its own `/state` and `/secrets`
- **Security Options**: Read-only root filesystem, dropped capabilities, no privilege escalation
- **Resources**: CPU, memory, and tmpfs quotas enforced

## Production Deployment

For production, you should use [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy).

This limits the scope of what `boilerhouse` can do with the docker socket provided to just creating/destroying containers.

There is an example `docker-compose.yml` in the `examples/deploy` directory.

### Configuring docker-socket-proxy

The proxy filters Docker API calls via environment variables. In `deploy/docker-compose.yml`:

`boilerhouse` only needs `CONTAINERS`, `IMAGES`, `POST`.

```yaml
docker-proxy:
  image: tecnativa/docker-socket-proxy:latest
  environment:
    # Enable (1) or disable (0) each endpoint category
    CONTAINERS: 1    # Required: create, start, stop, remove, inspect, list
    IMAGES: 1        # Required: pull images for workloads
    POST: 1          # Required: write operations
    # All others default to 0 (disabled):
    # EXEC, NETWORKS, VOLUMES, SWARM, NODES, SERVICES, etc.
```

| Endpoint   | Default | Description |
|------------|---------|-------------|
| CONTAINERS | 0       | Container operations (create, start, stop, remove) |
| IMAGES     | 0       | Image operations (pull, list) |
| POST       | 0       | Write operations (required for create/start/stop) |
| EXEC       | 0       | Execute commands in containers (dangerous) |
| NETWORKS   | 0       | Network management (not needed) |
| VOLUMES    | 0       | Volume management (we use bind mounts) |
| SWARM      | 0       | Swarm mode (single-node only) |

### Connecting Your Application

Your app must join the `boilerhouse` network to access the API:

```yaml
# In your docker-compose.yml
services:
  your-app:
    image: your-app:latest
    environment:
      BOILERHOUSE_URL: http://boilerhouse:3000
    networks:
      - boilerhouse
      - public
    ports:
      - "443:443"

networks:
  boilerhouse:
    external: true
    name: boilerhouse
```

### Host Directory Setup

Before starting, create the required host directories:

```bash
sudo mkdir -p /var/lib/boilerhouse/states
sudo mkdir -p /var/lib/boilerhouse/secrets
sudo mkdir -p /var/run/boilerhouse
```

## License

MIT
