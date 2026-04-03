# Compose-to-K8s for Minikube

**Date:** 2026-04-03
**Status:** Approved

## Problem

Kubernetes E2E tests fail because infrastructure dependencies (Redis, MinIO) defined in `docker-compose.yml` aren't available inside the minikube cluster. The API's trigger system unconditionally connects to Redis at startup (`apps/api/src/routes/trigger-adapters.ts:238`), causing `ioredis` connection errors and workload failures.

Maintaining separate Kubernetes manifests for these services would create drift against the compose file.

## Approach

A Bun script reads `docker-compose.yml` via `docker compose config --format json`, filters out observability services, and generates Kubernetes Deployment + Service manifests. The minikube setup script calls this to provision functional deps into the cluster automatically.

Docker-compose remains the single source of truth. Any new functional dependency added to compose is automatically deployed to minikube unless explicitly excluded.

## Components

### `scripts/compose-to-k8s.ts`

The translator script. Invoked as `bun run scripts/compose-to-k8s.ts`.

**Input:** Runs `docker compose config --format json` to get the parsed compose file as JSON. This avoids needing a YAML parser — docker compose handles all spec features (variable substitution, extends, etc.).

**Filtering:** Excludes a hardcoded list of observability/utility services:
- `prometheus`, `tempo`, `grafana` — observability stack, not needed for tests
- `minio-init` — not a standalone service; its logic is folded into an init container on the minio Deployment

Any compose service NOT in this list is automatically translated. This means adding a new functional dep to `docker-compose.yml` (e.g., postgres) automatically appears in minikube without touching the script.

**Output:** Kubernetes YAML to stdout, one document per resource (separated by `---`).

**Translation rules per service:**

| Compose concept | Kubernetes equivalent |
|---|---|
| `image` | Container image in Deployment pod spec |
| `ports` (host:container) | Service ports (only container port matters; ClusterIP, not NodePort) |
| `environment` | Container `env` array |
| `volumes` (named) | `emptyDir` volume + volumeMount (ephemeral is fine for local dev) |
| `command` | Container `command` |
| `depends_on` | Ignored (k8s handles readiness differently) |
| `extra_hosts` | Ignored (not needed inside cluster) |

**Special case — minio-init:** The `minio-init` compose service exists only to create the default bucket. In k8s, this becomes an init container on the minio Deployment. The script detects `minio-init` by name, extracts its image and entrypoint, and attaches it as an init container on the `minio` Deployment. The init container shares the minio data volume and connects to `localhost:9000` (same pod).

### `minikube.sh` changes

After the existing namespace/RBAC setup and before the "ready" message, add:

```sh
echo "Deploying infrastructure services from docker-compose.yml..."
bun run "$SCRIPT_DIR/scripts/compose-to-k8s.ts" \
  | kubectl --context="$PROFILE" -n "$NAMESPACE" apply -f -

echo "Waiting for infrastructure deployments..."
kubectl --context="$PROFILE" -n "$NAMESPACE" \
  wait --for=condition=available deployment --all --timeout=120s
```

### `e2e.sh` changes

When runtime is `kubernetes`, export env vars so the API connects to in-cluster services:

```sh
export REDIS_URL="redis://redis.boilerhouse.svc.cluster.local:6379"
```

MinIO (`S3_ENDPOINT`) follows the same pattern if S3 is enabled for tests.

### `dev.sh` changes

Same as `e2e.sh` — when runtime is `kubernetes`, set `REDIS_URL` to point at the in-cluster Redis service.

## Generated manifest structure

### Redis

**Deployment:**
- Image: `redis:7-alpine`
- Container port: 6379
- No env vars
- Labels: `app: redis`, `boilerhouse.dev/infra: "true"`

**Service:**
- ClusterIP, port 6379 → targetPort 6379
- Selector: `app: redis`

### MinIO

**Deployment:**
- Image: `minio/minio:latest`
- Command: `server /data --console-address ":9001"`
- Container ports: 9000, 9001
- Env: `MINIO_ROOT_USER=minioadmin`, `MINIO_ROOT_PASSWORD=minioadmin`
- Volume: `emptyDir` mounted at `/data`
- Init container (from `minio-init`): `minio/mc:latest`, runs bucket-creation script against `localhost:9000`
- Labels: `app: minio`, `boilerhouse.dev/infra: "true"`

**Service:**
- ClusterIP, ports 9000 + 9001
- Selector: `app: minio`

## Not in scope

- **Persistent volumes** — `emptyDir` is fine for local dev/test. Data doesn't survive pod restart, which is acceptable.
- **Ingress or NodePort** — Services are cluster-internal only. The API pod reaches them by DNS name.
- **Health checks on infra pods** — Kubernetes restarts on crash, good enough for local dev.
- **Observability stack in minikube** — Can be added later if needed.

## File inventory

| File | Action |
|---|---|
| `scripts/compose-to-k8s.ts` | New — translator script |
| `.kadai/actions/minikube.sh` | Modified — call translator, wait for readiness |
| `.kadai/actions/tests/e2e.sh` | Modified — set `REDIS_URL` for kubernetes runtime |
| `.kadai/actions/dev.sh` | Modified — set `REDIS_URL` for kubernetes runtime |
