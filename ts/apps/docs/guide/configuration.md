# Configuration

Boilerhouse binaries are configured via environment variables. Workload, pool, claim, and trigger behavior is configured via Custom Resources (see the respective guide pages).

## Environment Variables

See the [Environment Variables Reference](../reference/env) for the complete list. The most important ones:

### All Binaries

```bash
KUBECONFIG=/path/to/kubeconfig    # required outside the cluster
K8S_NAMESPACE=boilerhouse         # namespace for CRDs and Pods (default: boilerhouse)
LOG_LEVEL=info                    # debug | info | warn | error
```

When running as a Pod inside the cluster, `KUBECONFIG` is not needed — in-cluster service account credentials are used automatically.

### API Server

```bash
PORT=3000                          # listen port
LISTEN_HOST=127.0.0.1              # bind address
BOILERHOUSE_API_KEY=<string>       # optional: enables Bearer-token auth
CORS_ORIGIN=http://localhost:5173  # comma-separated origins for CORS
```

### Operator

```bash
METRICS_PORT=9464                  # Prometheus metrics port
HEALTH_PORT=8081                   # health/readiness probe port
LEADER_ELECT=true                  # set to "false" to disable leader election
WORKLOADS_DIR=/path/to/workloads   # required if using image.dockerfile builds
```

### Trigger Gateway

```bash
# No extra config — the gateway reads its configuration from BoilerhouseTrigger CRs
```

### Observability

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

## API Authentication

When `BOILERHOUSE_API_KEY` is set, all `/api/v1/*` routes except `/api/v1/health` and `/api/v1/stats` require a Bearer token:

```bash
curl http://localhost:3000/api/v1/workloads \
  -H "Authorization: Bearer your-api-key"
```

The `/ws` WebSocket endpoint is outside the auth middleware (the dashboard proxy doesn't forward the key). If you need to protect it, run the API behind a reverse proxy that enforces auth at the edge.

If `BOILERHOUSE_API_KEY` is not set, the API is unauthenticated (suitable for development only).

## CORS

Configure allowed origins for the dashboard:

```bash
export CORS_ORIGIN=http://localhost:5173,https://dashboard.example.com
```

Comma-separated list. `*` is accepted as a wildcard. When unset, CORS headers are not sent.

## Kubernetes Access

All three binaries use `sigs.k8s.io/controller-runtime` / `ctrl.GetConfig()` to find a kubeconfig. The lookup order is:

1. `KUBECONFIG` environment variable
2. `~/.kube/config`
3. In-cluster service account (when running as a Pod)

For production, deploy the binaries as Pods with the `boilerhouse-operator` ServiceAccount bound to the `boilerhouse-operator` ClusterRole (see `config/deploy/operator.yaml`).

## Workload Configuration

Workloads, pools, claims, and triggers are entirely configured through their Custom Resources:

- [Workloads](./workloads) — `BoilerhouseWorkload`
- [Pooling](./pooling) — `BoilerhousePool`
- [Tenants & Claims](./tenants) — `BoilerhouseClaim`
- [Triggers](./triggers) — `BoilerhouseTrigger`

The operator does not auto-discover YAML files on disk (the TS version's `WORKLOADS_DIR` did this). Apply CRs with `kubectl apply -f`, or use the REST API to create them programmatically. `WORKLOADS_DIR` on the operator is used only for resolving `image.dockerfile` paths when building images.
