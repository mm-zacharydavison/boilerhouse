# Environment Variables

Complete reference of all environment variables used by Boilerhouse.

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server listen port |
| `LISTEN_HOST` | `127.0.0.1` | API server listen address |
| `DB_PATH` | `boilerhouse.db` | SQLite database file path |
| `STORAGE_PATH` | `./data` | Local storage directory for overlays and snapshots |
| `RUNTIME_TYPE` | `docker` | Container runtime: `docker`, `kubernetes`, or `fake` |
| `MAX_INSTANCES` | `100` | Maximum concurrent instances per node |
| `WORKLOADS_DIR` | — | Directory to auto-discover `.workload.ts` and `.trigger.ts` files |
| `CORS_ORIGIN` | — | Comma-separated list of allowed CORS origins |

## Security

| Variable | Default | Description |
|----------|---------|-------------|
| `BOILERHOUSE_API_KEY` | — | API authentication key. When set, all requests require `Authorization: Bearer <key>` |
| `BOILERHOUSE_SECRET_KEY` | — | Master encryption key for tenant data and secrets. **Required for production.** |

## Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_PORT` | `9464` | Prometheus metrics endpoint port |
| `METRICS_HOST` | `127.0.0.1` | Prometheus metrics endpoint bind address |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry OTLP endpoint URL (e.g., `http://localhost:4318`) |
| `LOG_LEVEL` | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

## S3 Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_ENABLED` | `false` | Enable S3 backend for overlay storage |
| `S3_BUCKET` | — | S3 bucket name |
| `S3_REGION` | — | AWS region (e.g., `us-east-1`) or `auto` for S3-compatible |
| `S3_ENDPOINT` | — | Custom S3 endpoint URL (for MinIO, R2, Tigris, etc.) |
| `AWS_ACCESS_KEY_ID` | — | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | — | AWS secret key |

## Overlay Cache

| Variable | Default | Description |
|----------|---------|-------------|
| `OVERLAY_CACHE_DIR` | — | Local directory for overlay LRU cache. Defaults to `STORAGE_PATH` if not set. |
| `OVERLAY_CACHE_MAX_BYTES` | `10737418240` | Maximum cache size in bytes (default: 10 GB) |

## Docker Runtime

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_SOCKET` | Auto-detected | Path to Docker daemon socket. Auto-detects `/var/run/docker.sock` or `~/.docker/run/docker.sock` |
| `SECCOMP_PROFILE_PATH` | — | Path to a custom seccomp profile JSON file |
| `ENDPOINT_HOST` | `127.0.0.1` | Host returned in endpoint responses. Set to `host.docker.internal` for Docker-in-Docker |

## Kubernetes Runtime

| Variable | Default | Description |
|----------|---------|-------------|
| `K8S_API_URL` | — | Kubernetes API server URL (for token-based auth) |
| `K8S_TOKEN` | — | Bearer token for Kubernetes API authentication |
| `K8S_CA_CERT` | — | Path to Kubernetes CA certificate file |
| `K8S_NAMESPACE` | `boilerhouse` | Kubernetes namespace for Boilerhouse resources |
| `K8S_CONTEXT` | — | kubectl context name (for kubeconfig-based auth) |
| `K8S_MINIKUBE_PROFILE` | — | Minikube profile name (enables local image building and port forwarding) |

## Operator

| Variable | Default | Description |
|----------|---------|-------------|
| `LEADER_ELECTION_NAMESPACE` | — | Namespace for the leader election Lease resource |
| `LEADER_ELECTION_NAME` | — | Name of the leader election Lease |
| `INTERNAL_API_PORT` | `9090` | Operator internal API port (health checks, stats) |
