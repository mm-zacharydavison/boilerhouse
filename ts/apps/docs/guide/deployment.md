# Deployment

Boilerhouse deploys as three Go binaries running against a Kubernetes cluster: the operator, the API server, and the trigger gateway. Kustomize manifests under `config/deploy/` contain a reference production layout.

## Prerequisites

- Kubernetes 1.26+ cluster
- `kubectl` with cluster-admin access
- A container registry for the three Boilerhouse images
- (Optional) `kustomize` or recent `kubectl` with built-in kustomize support

## Building Images

Three Dockerfiles live in `go/`:

```bash
cd go
docker build -f Dockerfile.operator -t <registry>/boilerhouse-operator:<tag> .
docker build -f Dockerfile.api      -t <registry>/boilerhouse-api:<tag>      .
docker build -f Dockerfile.trigger  -t <registry>/boilerhouse-trigger:<tag>  .
docker push <registry>/boilerhouse-operator:<tag>
docker push <registry>/boilerhouse-api:<tag>
docker push <registry>/boilerhouse-trigger:<tag>
```

For minikube development, build directly inside the cluster's Docker daemon:

```bash
eval "$(minikube docker-env -p boilerhouse)"
cd go
docker build -f Dockerfile.operator -t boilerhouse-operator:latest .
docker build -f Dockerfile.api      -t boilerhouse-api:latest      .
docker build -f Dockerfile.trigger  -t boilerhouse-trigger:latest  .
```

## Install CRDs

Apply the four Custom Resource Definitions generated from the Go types:

```bash
kubectl apply -f config/crd/bases-go/
```

This installs:
- `boilerhouseworkloads.boilerhouse.dev`
- `boilerhousepools.boilerhouse.dev`
- `boilerhouseclaims.boilerhouse.dev`
- `boilerhousetriggers.boilerhouse.dev`

## Deploy

The reference manifests under `config/deploy/` install the namespace, RBAC, operator, API, and trigger gateway:

```bash
kubectl apply -k config/deploy/
```

This applies:
- `namespace.yaml` — the `boilerhouse` namespace
- CRDs from `config/crd/bases/`
- `operator.yaml` — ServiceAccount, ClusterRole, ClusterRoleBinding, and the operator Deployment
- `api.yaml` — the API Deployment and its Service
- `trigger.yaml` — the trigger gateway Deployment

Edit image references in `config/deploy/*.yaml` to point at your registry before applying.

## RBAC

The operator needs cluster-scoped permissions to manage Pods, Services, ConfigMaps, Secrets, PersistentVolumeClaims, Events, NetworkPolicies, Leases, and the four Boilerhouse CRDs. The reference `ClusterRole` in `config/deploy/operator.yaml`:

```yaml
rules:
  - apiGroups: ["boilerhouse.dev"]
    resources: ["*"]
    verbs: ["*"]
  - apiGroups: ["boilerhouse.dev"]
    resources: ["*/status"]
    verbs: ["get", "update", "patch"]
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "secrets", "persistentvolumeclaims", "events"]
    verbs: ["*"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["*"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["*"]
```

The API and trigger gateway share the `boilerhouse-operator` ServiceAccount in the reference manifests. Tighten this in production if you want per-component RBAC.

## High Availability

The operator supports Kubernetes `Lease`-based leader election. Deploy with multiple replicas:

```yaml
spec:
  replicas: 2
```

Only the leader reconciles; other replicas are on standby and take over automatically on leader failure. Disable with `LEADER_ELECT=false` for single-instance deployments.

The API server is stateless — scale it horizontally with no coordination. The trigger gateway currently does not coordinate between replicas, so run a single replica to avoid duplicate event handling.

## Snapshots PVC

The operator expects a PVC named `boilerhouse-snapshots` for tenant overlay storage, mounted by the `boilerhouse-snapshot-helper` Pod. Add a PVC manifest to your deploy:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: boilerhouse-snapshots
  namespace: boilerhouse
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 50Gi
  storageClassName: <your-storage-class>
```

Use a storage class backed by a durable provider (EBS, GCP PD, Longhorn, etc.). `ReadWriteOnce` is sufficient because only the single helper Pod mounts the volume.

## Production Checklist

### Security

- [ ] Set `BOILERHOUSE_API_KEY` for API authentication
- [ ] Use `restricted` network access for untrusted workloads
- [ ] Put the API server behind an Ingress with TLS termination
- [ ] Create tenant credential Secrets in the `boilerhouse` namespace, not client-side
- [ ] Tighten RBAC if the API / trigger gateway don't need the full operator ClusterRole

### Storage

- [ ] Provision the `boilerhouse-snapshots` PVC with a durable storage class
- [ ] Choose a storage class that provides encryption at rest if required

### Observability

- [ ] Scrape `:9464/metrics` on the operator Pod
- [ ] Configure `OTEL_EXPORTER_OTLP_ENDPOINT` on all three binaries
- [ ] Set `LOG_LEVEL=info` for production
- [ ] Monitor key metrics:
  - `boilerhouse.pool.depth` — pool health
  - `boilerhouse.tenant.claim.duration` — claim latency
  - `boilerhouse.instances` (phase=Running) — live instance count
  - `kube_pod_status_phase` — standard Pod-level health from kube-state-metrics

### Resources

- [ ] Apply a `ResourceQuota` to the `boilerhouse` namespace to cap total CPU/memory
- [ ] Size workload resources (CPU, memory, disk) appropriately
- [ ] Configure pool sizes based on expected concurrency
- [ ] Set `maxFillConcurrency` to avoid swamping the scheduler during pool refill

### Networking

- [ ] Configure domain allowlists for restricted workloads
- [ ] Create Kubernetes Secrets for credential injection
- [ ] If workloads need external access, expose their Services via Ingress / LoadBalancer
