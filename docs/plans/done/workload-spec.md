# Workload Specification Reference

This document describes the YAML format for defining workload specifications in Boilerhouse.

A workload defines a complete deployable unit: container configuration, pool sizing, and state synchronization - all in one file.

Workload specifications are validated at load time using [Zod](https://zod.dev). The schema definition can be found in `packages/core/src/schemas/workload.ts`.

## Field Origin Legend

| Icon | Meaning                                                                 |
|------|-------------------------------------------------------------------------|
| 🐳   | docker-compose compatible - same field name and semantics               |
| 🏠   | Boilerhouse-specific - unique to this project                           |

## Quick Start

Create a workload file in `config/workloads/`:

```yaml
id: my-workload
name: My Custom Workload
image: myregistry/myapp:latest

volumes:
  state:
    target: /data
  secrets:
    target: /secrets
    read_only: true

environment:
  APP_MODE: production

healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s
  timeout: 5s
  retries: 3

deploy:
  resources:
    limits:
      cpus: "2"
      memory: 512M

pool:
  min_size: 5
  max_size: 50
  idle_timeout: 10m

sync:
  sink:
    type: s3
    bucket: my-bucket
    region: us-west-2
  mappings:
    - path: /data
      direction: bidirectional
  policy:
    on_claim: true
    on_release: true
    interval: 5m
```

## Configuration

### Environment Variable

| Variable                    | Default              | Description                     |
|-----------------------------|----------------------|---------------------------------|
| `BOILERHOUSE_WORKLOADS_DIR` | `./config/workloads` | Directory containing YAML files |

## Schema Reference

### Root Fields

| Field        | Type    | Required | Origin | Description                                        |
|--------------|---------|----------|--------|----------------------------------------------------|
| `id`         | string  | Yes      | 🏠     | Unique identifier (lowercase, alphanumeric, hyphens) |
| `name`       | string  | Yes      | 🏠     | Human-readable name                                |
| `image`      | string  | Yes      | 🐳     | Docker image reference                             |
| `volumes`    | object  | No       | 🐳     | Volume mount configuration                         |
| `environment`| object  | No       | 🐳     | Environment variables                              |
| `healthcheck`| object  | Yes      | 🐳     | Health check configuration                         |
| `deploy`     | object  | No       | 🐳     | Deploy configuration with resource limits          |
| `read_only`  | boolean | No       | 🐳     | Read-only root filesystem                          |
| `user`       | string  | No       | 🐳     | User to run as                                     |
| `network_mode`| string | No       | 🐳     | Network mode: `none`, `bridge`, `host`             |
| `pool`       | object  | No       | 🏠     | Pool sizing configuration                          |
| `sync`       | object  | No       | 🏠     | State synchronization configuration                |

### Volumes

The `volumes` object supports predefined mount points. Field names match docker-compose long syntax:

```yaml
volumes:
  state:           # Persistent tenant data (boilerhouse-managed)
    target: /data
  secrets:         # Credentials (boilerhouse-managed)
    target: /secrets
    read_only: true
  comm:            # IPC/sockets (boilerhouse-managed)
    target: /comm
  custom:          # Additional volumes
    - name: models
      target: /models
      read_only: true
```

| Field       | Type    | Default  | Origin | Description                   |
|-------------|---------|----------|--------|-------------------------------|
| `target`    | string  | Required | 🐳     | Path inside the container     |
| `read_only` | boolean | `false`  | 🐳     | Mount as read-only            |

Note: `state`, `secrets`, `comm` are 🏠 Boilerhouse volume roles with managed host paths. The fields within them (`target`, `read_only`) are 🐳 docker-compose compatible.

### Health Check

Field names match docker-compose `healthcheck` spec:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

| Field          | Type         | Required | Origin | Description                                     |
|----------------|--------------|----------|--------|-------------------------------------------------|
| `test`         | string[]     | Yes      | 🐳     | Command to execute (e.g., `["CMD", "curl", ...]`) |
| `interval`     | number/string| Yes      | 🐳     | Interval between checks (ms or duration)        |
| `timeout`      | number/string| Yes      | 🐳     | Timeout per check (ms or duration)              |
| `retries`      | number       | Yes      | 🐳     | Consecutive failures before unhealthy           |
| `start_period` | number/string| No       | 🐳     | Grace period before starting health checks      |

### Deploy (Resources)

Matches docker-compose `deploy.resources` structure:

```yaml
deploy:
  resources:
    limits:
      cpus: "2"
      memory: 2G
    reservations:
      cpus: "0.5"
      memory: 512M
```

| Field                             | Type          | Required | Origin | Description                      |
|-----------------------------------|---------------|----------|--------|----------------------------------|
| `deploy.resources.limits.cpus`    | string/number | No       | 🐳     | CPU limit                        |
| `deploy.resources.limits.memory`  | string/number | No       | 🐳     | Memory limit (e.g., "512M", "2G")|
| `deploy.resources.reservations`   | object        | No       | 🐳     | Resource reservations            |

### Security Options

Security options are at the top level to match docker-compose:

```yaml
read_only: true
user: "1000"
network_mode: none
```

| Field          | Type   | Default | Origin | Description                            |
|----------------|--------|---------|--------|----------------------------------------|
| `read_only`    | boolean| -       | 🐳     | Read-only root filesystem              |
| `user`         | string | -       | 🐳     | User ID or name to run as              |
| `network_mode` | string | -       | 🐳     | Network mode: `none`, `bridge`, `host` |

### Pool Configuration

Pool settings control how many container instances are maintained:

```yaml
pool:
  min_size: 5           # Minimum idle containers (default: 1)
  max_size: 50          # Maximum total containers (default: 10)
  idle_timeout: 10m     # Evict idle containers after this duration
  network:              # Optional network configuration
    name: my-network
    dns:
      - 8.8.8.8
      - 8.8.4.4
```

| Field          | Type          | Default | Origin | Description                               |
|----------------|---------------|---------|--------|-------------------------------------------|
| `min_size`     | number        | 1       | 🏠     | Minimum number of pre-warmed containers   |
| `max_size`     | number        | 10      | 🏠     | Maximum containers in the pool            |
| `idle_timeout` | number/string | -       | 🏠     | Duration before idle container is evicted |
| `network`      | object        | -       | 🏠     | Docker network configuration              |

### Sync Configuration

Sync settings control state persistence to remote storage (S3, etc.):

```yaml
sync:
  sink:
    type: s3
    bucket: my-bucket
    region: us-west-2
    prefix: tenants/${tenantId}/

  mappings:
    - path: /data
      pattern: "*.json"
      direction: bidirectional
      mode: sync

  policy:
    on_claim: true
    on_release: true
    interval: 5m
    manual: true
```

#### Sink Configuration

Currently supports S3 (more sinks planned):

| Field               | Type   | Required | Origin | Description                                            |
|---------------------|--------|----------|--------|--------------------------------------------------------|
| `type`              | string | Yes      | 🏠     | Sink type (`s3`)                                       |
| `bucket`            | string | Yes      | 🏠     | S3 bucket name                                         |
| `region`            | string | Yes      | 🏠     | AWS region                                             |
| `prefix`            | string | No       | 🏠     | Path prefix, supports `${tenantId}` (default: `tenants/${tenantId}/`) |
| `access_key_id`     | string | No       | 🏠     | AWS access key (optional if using IAM role)            |
| `secret_access_key` | string | No       | 🏠     | AWS secret key (optional if using IAM role)            |
| `endpoint`          | string | No       | 🏠     | Custom S3 endpoint (for S3-compatible services)        |
| `rclone_flags`      | array  | No       | 🏠     | Additional rclone flags                                |

#### Sync Mappings

Define which paths to sync:

| Field       | Type   | Default         | Origin | Description                              |
|-------------|--------|-----------------|--------|------------------------------------------|
| `path`      | string | Required        | 🏠     | Container path to sync                   |
| `pattern`   | string | -               | 🏠     | Glob pattern to filter files             |
| `sink_path` | string | path basename   | 🏠     | Destination prefix in sink               |
| `direction` | string | `bidirectional` | 🏠     | `upload`, `download`, or `bidirectional` |
| `mode`      | string | `sync`          | 🏠     | `sync` (mirrors) or `copy` (preserves)   |

#### Sync Policy

Control when sync happens:

| Field        | Type          | Default | Origin | Description                            |
|--------------|---------------|---------|--------|----------------------------------------|
| `on_claim`   | boolean       | true    | 🏠     | Download state when tenant claims      |
| `on_release` | boolean       | true    | 🏠     | Upload state when tenant releases      |
| `interval`   | number/string | -       | 🏠     | Periodic sync interval (ms or duration)|
| `manual`     | boolean       | true    | 🏠     | Allow manual sync trigger via API      |

### Duration Strings

Durations can be specified as numbers (milliseconds) or strings with suffixes: `ms` (milliseconds), `s` (seconds), `m` (minutes), `h` (hours).

Examples: `30s`, `5m`, `1000ms`, `1h`, `30000`

### Memory Strings

Memory values can be specified as numbers (megabytes) or strings with suffixes: `b`, `k`/`kb`, `m`/`mb`, `g`/`gb`. Note: docker-compose uses uppercase (e.g., `512M`, `2G`).

Examples: `512M`, `2G`, `256mb`, `512`

## Complete Example

```yaml
id: python-worker
name: Python ML Worker
image: python:3.11-slim

volumes:
  state:
    target: /data
  secrets:
    target: /secrets
    read_only: true
  custom:
    - name: models
      target: /models
      read_only: true

environment:
  PYTHONUNBUFFERED: "1"
  STATE_DIR: /data
  MODEL_DIR: /models

healthcheck:
  test: ["CMD", "python", "-c", "print('ok')"]
  interval: 30s
  timeout: 10s
  retries: 3

deploy:
  resources:
    limits:
      cpus: "2"
      memory: 2G

read_only: true
user: "1000"
network_mode: none

pool:
  min_size: 5
  max_size: 50
  idle_timeout: 10m

sync:
  sink:
    type: s3
    bucket: ml-worker-state
    region: us-west-2
    prefix: tenants/${tenantId}/

  mappings:
    - path: /data
      direction: bidirectional
      mode: sync

  policy:
    on_claim: true
    on_release: true
    interval: 5m
```

## File Organization

```
config/
└── workloads/
    ├── default.yaml           # Default workload (required)
    ├── python-worker.yaml
    ├── node-api.yaml
    └── examples/              # Example workloads (not loaded by default)
        └── ...
```

## Hot Reload

In development mode (`NODE_ENV !== 'production'`), changes to YAML files are automatically detected and the workload registry is reloaded.

## API Integration

Workloads can also be managed via the API:

```bash
# List workloads
curl http://localhost:3000/workloads

# Get workload
curl http://localhost:3000/workloads/python-worker

# Create workload (writes to file)
curl -X POST http://localhost:3000/workloads \
  -H "Content-Type: application/json" \
  -d '{"id": "custom", "name": "Custom", "image": "alpine:latest", ...}'

# Update workload (writes to file)
curl -X PUT http://localhost:3000/workloads/custom \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Custom", ...}'

# Delete workload (deletes file)
curl -X DELETE http://localhost:3000/workloads/custom
```
