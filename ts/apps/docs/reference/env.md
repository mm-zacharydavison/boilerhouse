# Environment Variables

Complete reference of all environment variables used by Boilerhouse. The Go rewrite reads far fewer variables than the TypeScript version — most configuration now lives in Custom Resources.

## Shared (all binaries)

| Variable | Default | Description |
|----------|---------|-------------|
| `KUBECONFIG` | `~/.kube/config` | Path to kubeconfig file. Not needed when running in-cluster. |
| `K8S_NAMESPACE` | `boilerhouse` | Namespace where CRDs and Pods are managed |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## API Server (`cmd/api`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `LISTEN_HOST` | `127.0.0.1` | Bind address |
| `BOILERHOUSE_API_KEY` | — | Bearer token for `/api/v1/*` routes. When unset, the API is unauthenticated. |
| `CORS_ORIGIN` | — | Comma-separated list of allowed CORS origins. `*` is accepted as wildcard. |

## Operator (`cmd/operator`)

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_PORT` | `9464` | Prometheus metrics endpoint port |
| `HEALTH_PORT` | `8081` | Health/readiness probe port |
| `LEADER_ELECT` | `true` | Enable leader election via Kubernetes `Lease`. Set to `"false"` to disable. |
| `WORKLOADS_DIR` | — | Directory containing Dockerfiles referenced by `image.dockerfile` in workload specs. Only required if you use Dockerfile-based workload images. |

## Trigger Gateway (`cmd/trigger`)

The trigger gateway reads its configuration from `BoilerhouseTrigger` Custom Resources; it has no trigger-specific environment variables beyond the shared set.

## Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry OTLP HTTP endpoint (e.g., `http://otel-collector:4318`) |

## What Was Removed

These variables existed in the TypeScript implementation and no longer apply:

| Removed | Replacement |
|---------|-------------|
| `DB_PATH`, `STORAGE_PATH` | All state lives in the Kubernetes API |
| `RUNTIME_TYPE` | Kubernetes is the only runtime |
| `MAX_INSTANCES` | Use Kubernetes `ResourceQuota` on the namespace |
| `BOILERHOUSE_SECRET_KEY` | Overlay encryption is the PVC storage class's responsibility; credential injection uses Kubernetes `Secret` resources |
| `S3_*`, `AWS_*`, `OVERLAY_CACHE_*` | Overlay archives are stored on a `PersistentVolumeClaim` |
| `DOCKER_SOCKET`, `SECCOMP_PROFILE_PATH`, `ENDPOINT_HOST` | Docker runtime removed |
| `K8S_API_URL`, `K8S_TOKEN`, `K8S_CA_CERT`, `K8S_CONTEXT`, `K8S_MINIKUBE_PROFILE` | All binaries use `ctrl.GetConfig()` (KUBECONFIG or in-cluster) |
| `LEADER_ELECTION_NAMESPACE`, `LEADER_ELECTION_NAME` | Hard-coded to `K8S_NAMESPACE` / `boilerhouse-operator` |
| `METRICS_HOST` | Metrics bind to `0.0.0.0:$METRICS_PORT` |
