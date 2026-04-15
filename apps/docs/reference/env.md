# Environment Variables

Quick reference for all Boilerhouse environment variables. For detailed explanations of each category, see [Configuration](../guide/configuration.md).

## Core

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP server port |
| `LISTEN_HOST` | `127.0.0.1` | No | HTTP bind address |
| `DB_PATH` | `boilerhouse.db` | No | SQLite database file path |
| `STORAGE_PATH` | `./data` | No | Data storage directory |
| `RUNTIME_TYPE` | `docker` | No | Runtime backend: `docker`, `podman`, or `kubernetes` |
| `MAX_INSTANCES` | `100` | No | Maximum instances per node |
| `WORKLOADS_DIR` | -- | No | Directory containing workload definitions |

## Security

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `BOILERHOUSE_SECRET_KEY` | -- | Yes | 32-byte hex string for encryption (AES-256-GCM) |
| `BOILERHOUSE_API_KEY` | -- | No | API bearer token; all `/api/v1` routes (except `/health`) require auth when set |

## Observability

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `METRICS_PORT` | `9464` | No | Prometheus metrics endpoint port |
| `METRICS_HOST` | `127.0.0.1` | No | Metrics bind address |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | -- | No | OpenTelemetry collector URL |

## S3 Storage

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `S3_ENABLED` | -- | No | Set to `true` to enable S3 snapshot backend |
| `S3_BUCKET` | -- | When S3 enabled | S3 bucket name |
| `S3_REGION` | -- | When S3 enabled | AWS region |
| `S3_ENDPOINT` | -- | No | Custom S3 endpoint (MinIO, R2, etc.) |
| `AWS_ACCESS_KEY_ID` | -- | When S3 enabled | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | -- | When S3 enabled | AWS secret key |

## Overlay Cache

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `OVERLAY_CACHE_DIR` | `./data/cache/overlays` | No | Overlay cache directory |
| `OVERLAY_CACHE_MAX_BYTES` | `10737418240` (10 GB) | No | Max cache size in bytes |

## Docker Runtime

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DOCKER_SOCKET` | -- | No | Docker socket path (uses default if unset) |
| `SECCOMP_PROFILE_PATH` | -- | No | Custom seccomp profile for containers |

## Kubernetes Runtime

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `K8S_API_URL` | -- | For K8s | Kubernetes API server URL |
| `K8S_TOKEN` | -- | For K8s | Service account token |
| `K8S_CA_CERT` | -- | No | CA certificate for TLS verification |
| `K8S_NAMESPACE` | `boilerhouse` | No | Kubernetes namespace |
| `K8S_CONTEXT` | -- | No | Kubeconfig context (alternative to URL/token) |
| `K8S_MINIKUBE_PROFILE` | -- | No | Minikube profile for local dev |

## Other

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `CORS_ORIGIN` | -- | No | Comma-separated allowed origins; CORS disabled if unset |
| `REDIS_URL` | `redis://localhost:6379` | No | Redis URL for trigger queue |
