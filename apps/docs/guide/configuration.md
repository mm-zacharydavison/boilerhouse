# Configuration

Boilerhouse is configured entirely through environment variables. This page documents every variable, organized by category.

For a flat quick-reference table, see [Environment Variables](../reference/env.md).

## Environment Variables

### Core

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP server port |
| `LISTEN_HOST` | `127.0.0.1` | No | HTTP bind address |
| `DB_PATH` | `boilerhouse.db` | No | SQLite database file path |
| `STORAGE_PATH` | `./data` | No | Data storage directory |
| `RUNTIME_TYPE` | `docker` | No | Runtime backend: `docker`, `podman`, or `kubernetes` |
| `MAX_INSTANCES` | `100` | No | Maximum instances per node |
| `WORKLOADS_DIR` | -- | No | Directory containing workload definitions |

### Security

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `BOILERHOUSE_SECRET_KEY` | -- | Yes | 32-byte hex string for encryption (AES-256-GCM) |
| `BOILERHOUSE_API_KEY` | -- | No | API bearer token; when set, all `/api/v1` routes (except `/health`) require auth |

::: warning
`BOILERHOUSE_SECRET_KEY` is required for all deployments. It encrypts tenant data overlays at rest. Generate one with:
```bash
openssl rand -hex 32
```
:::

### Observability

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `METRICS_PORT` | `9464` | No | Prometheus metrics endpoint port |
| `METRICS_HOST` | `127.0.0.1` | No | Metrics bind address |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | -- | No | OpenTelemetry collector URL |

### S3 Storage

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `S3_ENABLED` | -- | No | Set to `true` to enable S3 snapshot backend |
| `S3_BUCKET` | -- | When S3 enabled | S3 bucket name |
| `S3_REGION` | -- | When S3 enabled | AWS region |
| `S3_ENDPOINT` | -- | No | Custom S3 endpoint (MinIO, R2, etc.) |
| `AWS_ACCESS_KEY_ID` | -- | When S3 enabled | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | -- | When S3 enabled | AWS secret key |

### Overlay Cache

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `OVERLAY_CACHE_DIR` | `./data/cache/overlays` | No | Overlay cache directory |
| `OVERLAY_CACHE_MAX_BYTES` | `10737418240` (10 GB) | No | Max cache size in bytes |

### Docker Runtime

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DOCKER_SOCKET` | -- | No | Docker socket path (uses default if unset) |
| `SECCOMP_PROFILE_PATH` | -- | No | Custom seccomp profile for containers |

### Kubernetes Runtime

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `K8S_API_URL` | -- | For K8s | Kubernetes API server URL |
| `K8S_TOKEN` | -- | For K8s | Service account token |
| `K8S_CA_CERT` | -- | No | CA certificate for TLS verification |
| `K8S_NAMESPACE` | `boilerhouse` | No | Kubernetes namespace |
| `K8S_CONTEXT` | -- | No | Kubeconfig context (alternative to URL/token) |
| `K8S_MINIKUBE_PROFILE` | -- | No | Minikube profile for local dev |

### Other

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `CORS_ORIGIN` | -- | No | Comma-separated allowed origins; CORS disabled if unset |
| `REDIS_URL` | `redis://localhost:6379` | No | Redis URL for trigger queue |

## API Authentication

When `BOILERHOUSE_API_KEY` is set, all requests to `/api/v1/*` (except `/health`) must include an `Authorization` header:

```
Authorization: Bearer <key>
```

WebSocket connections authenticate via the `token` query parameter:

```
ws://localhost:3000/ws?token=<key>
```

Requests without a valid token receive a `401 Unauthorized` response.

## Database

Boilerhouse uses SQLite via Drizzle ORM. The database file is created automatically at the path specified by `DB_PATH` if it does not already exist.

Migrations run automatically on startup -- there is no separate migration command. The schema is versioned alongside the application binary, so upgrading the binary and restarting is sufficient to apply new migrations.

::: tip
For production deployments, back up the SQLite file regularly. The database holds workload definitions, tenant state, instance metadata, and audit logs.
:::

## Runtime Selection

Set `RUNTIME_TYPE` to choose the container runtime backend. The runtime is selected once at startup and cannot be changed without restarting the process.

| Value | Description |
|-------|-------------|
| `docker` | Docker Engine via Unix socket (default) |
| `podman` | Podman-compatible Docker API |
| `kubernetes` | Kubernetes cluster via API server |

Each runtime has its own set of environment variables (see the Docker and Kubernetes tables above). The Docker and Podman runtimes share the same configuration variables. The Kubernetes runtime requires either `K8S_API_URL` + `K8S_TOKEN` or a `K8S_CONTEXT` from your kubeconfig.

See [Docker Runtime](./runtime-docker.md) and [Kubernetes Runtime](./runtime-kubernetes.md) for runtime-specific setup guides.
