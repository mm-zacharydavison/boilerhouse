# Configuration

Boilerhouse is configured via environment variables and workload definition files.

## Environment Variables

See the [Environment Variables Reference](../reference/env) for the complete list. The most important ones:

### Core

```bash
PORT=3000                    # API listen port
LISTEN_HOST=127.0.0.1        # API listen address
DB_PATH=boilerhouse.db       # SQLite database path
STORAGE_PATH=./data          # Local storage directory
RUNTIME_TYPE=docker          # docker | kubernetes | fake
MAX_INSTANCES=100            # Maximum concurrent instances
```

### Security

```bash
BOILERHOUSE_API_KEY=your-api-key      # API authentication (optional)
BOILERHOUSE_SECRET_KEY=your-secret    # Encryption key (required for tenant data encryption)
```

### Workloads

```bash
WORKLOADS_DIR=./workloads    # Auto-discover .workload.ts and .trigger.ts files
```

## API Authentication

When `BOILERHOUSE_API_KEY` is set, all API requests must include a Bearer token:

```bash
curl http://localhost:3000/api/v1/workloads \
  -H "Authorization: Bearer your-api-key"
```

WebSocket connections pass the token as a query parameter:

```
ws://localhost:3000/ws?token=your-api-key
```

If `BOILERHOUSE_API_KEY` is not set, the API is unauthenticated (suitable for development only).

## Database

Boilerhouse uses SQLite via Drizzle ORM. The database file is created automatically on first run.

```bash
export DB_PATH=boilerhouse.db  # default: boilerhouse.db in working directory
```

Migrations run automatically on startup. The database stores workloads, instances, tenants, claims, snapshots, triggers, and the activity log.

For the Kubernetes operator, the database is stored at a configurable path within the operator's filesystem (or a PersistentVolume for durability).

## Runtime Selection

```bash
export RUNTIME_TYPE=docker       # Use Docker runtime (default)
export RUNTIME_TYPE=kubernetes   # Use Kubernetes runtime (operator)
export RUNTIME_TYPE=fake         # Use in-memory fake runtime (testing)
```

### Docker Runtime Config

```bash
export DOCKER_SOCKET=/var/run/docker.sock    # Auto-detected
export SECCOMP_PROFILE_PATH=/path/to.json    # Optional seccomp profile
```

### Kubernetes Runtime Config

```bash
# Option 1: In-cluster (automatic when running as a Pod)
# No configuration needed

# Option 2: Token-based
export K8S_API_URL=https://kubernetes.default.svc
export K8S_TOKEN=eyJhbGciOiJS...
export K8S_CA_CERT=/path/to/ca.crt

# Option 3: Kubeconfig context
export K8S_CONTEXT=my-cluster

# Common
export K8S_NAMESPACE=boilerhouse             # default: boilerhouse
export K8S_MINIKUBE_PROFILE=boilerhouse-test # for local development
```

## Storage Configuration

### Local Only

```bash
export STORAGE_PATH=./data
```

### S3 + Local Cache

```bash
export S3_ENABLED=true
export S3_BUCKET=my-boilerhouse
export S3_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export OVERLAY_CACHE_DIR=./cache
export OVERLAY_CACHE_MAX_BYTES=10737418240  # 10 GB
```

### S3-Compatible (MinIO)

```bash
export S3_ENABLED=true
export S3_ENDPOINT=http://localhost:9000
export S3_BUCKET=boilerhouse
export AWS_ACCESS_KEY_ID=minioadmin
export AWS_SECRET_ACCESS_KEY=minioadmin
```

See [Storage](./storage) for details.

## Observability Configuration

```bash
# Prometheus metrics
export METRICS_PORT=9464
export METRICS_HOST=127.0.0.1

# OpenTelemetry tracing
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Log level
export LOG_LEVEL=info   # trace | debug | info | warn | error | fatal
```

See [Observability](./observability) for details.

## Workload Auto-Discovery

When `WORKLOADS_DIR` is set, the API server:

1. Scans the directory for `*.workload.ts` and `*.trigger.ts` files on startup
2. Registers each workload and trigger automatically
3. Watches the directory for changes and reloads workloads when files change
4. Primes pools when workloads are created or updated

```bash
export WORKLOADS_DIR=./workloads
```

File naming convention:
- `my-agent.workload.ts` — workload definition
- `my-trigger.trigger.ts` — trigger definition

## CORS

Configure allowed origins for the dashboard and API clients:

```bash
export CORS_ORIGIN=http://localhost:5173,https://dashboard.example.com
```

Comma-separated list of allowed origins.
