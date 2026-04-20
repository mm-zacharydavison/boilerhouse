# Storage

Boilerhouse persists tenant overlay archives on a Kubernetes `PersistentVolumeClaim`. Everything else — workloads, pools, claims, triggers — lives in the Kubernetes API server itself, so there is no separate database to configure.

## What Gets Stored Where

| Data | Storage |
|------|---------|
| Workload / pool / claim / trigger definitions | Kubernetes API (CRDs) |
| Running instances | Kubernetes Pods |
| Per-workload config (Envoy, etc.) | ConfigMaps |
| Credentials for injection | Kubernetes `Secret` resources |
| Tenant overlay archives | `PersistentVolumeClaim` mounted by the snapshot helper Pod |
| Leader election | `coordination.k8s.io/Lease` |

## Snapshot PVC

The operator expects a PVC named `boilerhouse-snapshots` in its namespace, mounted at `/snapshots` inside the `boilerhouse-snapshot-helper` Pod. The helper runs `tar`, `find`, and `cat` against this PVC on behalf of the operator and API.

### Layout

```
/snapshots/
├── <tenantId>/
│   ├── <workload>.tar.gz
│   └── <other-workload>.tar.gz
└── <another-tenantId>/
    └── <workload>.tar.gz
```

Each archive is the `tar czf` output of the workload's `overlayDirs`.

### Sizing

Size the PVC based on:
- Expected number of active tenants
- Average overlay size per tenant
- Retention policy (currently: overlays persist until the tenant's next hibernation or manual cleanup)

### Storage Class

The PVC can use any storage class the cluster supports. For production, use a storage class backed by a durable provider (EBS, GCP PD, Longhorn, etc.). For local development, minikube's default `standard` class works.

Adjust the PVC spec in `config/deploy/` to match your cluster.

## Secrets

Workload credential injection references Kubernetes `Secret` resources in the operator's namespace:

```yaml
network:
  credentials:
    - domain: api.anthropic.com
      headers:
        - name: x-api-key
          valueFrom:
            secretKeyRef:
              name: anthropic-api
              key: key
```

Create secrets with `kubectl`:

```bash
kubectl -n boilerhouse create secret generic anthropic-api \
  --from-literal=key="sk-ant-..."
```

For production, integrate with External Secrets Operator, Vault CSI, or your cloud provider's secret manager — anything that projects secrets into the `boilerhouse` namespace.

## What's No Longer Here

The TypeScript implementation had a blob store with disk, S3, and encrypted-tiered backends; a SQLite database; and a per-tenant encrypted secret store. The Go rewrite replaced all of those with native Kubernetes primitives:

| Old (TS) | New (Go) |
|----------|---------|
| SQLite + Drizzle ORM | Kubernetes API server |
| `BlobStore` / `DiskCache` / S3 backend | `PersistentVolumeClaim` + snapshot helper Pod |
| `BOILERHOUSE_SECRET_KEY` + AES-GCM overlay encryption | Disk encryption is the PVC's concern (cluster-level) |
| Per-tenant secret store | Kubernetes `Secret` resources |

If you need overlay encryption at rest, use a storage class that provides encryption (most cloud-backed ones do).
