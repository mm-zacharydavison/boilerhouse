# Deploying Boilerhouse on Kubernetes

Boilerhouse can run inside a Kubernetes cluster using its Kubernetes
runtime backend. In this mode, tenant instances are created as Kubernetes
pods with Envoy sidecars — no podmand or CRIU required.

**Trade-off**: No CRIU checkpoint/restore means no instant fork-style
provisioning. Tenant instances cold-boot instead of restoring from
snapshots. Use this when you already have a cluster and don't need
sub-second provisioning.

## Architecture

```
┌─── your namespace ────────────────────────────────┐
│                                                    │
│  ┌─────────────┐    ┌──────────────────────┐       │
│  │  your app   │───▶│  boilerhouse-api     │       │
│  │  (pod)      │    │  (deployment)        │       │
│  └─────────────┘    └──────────┬───────────┘       │
│                                │ K8s API           │
│                    ┌───────────▼────────────┐      │
│                    │  tenant pods           │      │
│                    │  (created by BH API)   │      │
│                    └───────────────────────-┘      │
└────────────────────────────────────────────────────┘
```

No podmand, no host dependencies. Everything runs as normal K8s resources.

## Step 1: Build the image

Boilerhouse does not publish pre-built images yet. Build from the repo:

```bash
docker build -t ghcr.io/<org>/boilerhouse-api:latest \
  -f Dockerfile .
docker push ghcr.io/<org>/boilerhouse-api:latest
```

The `Dockerfile` in the boilerhouse repo root builds the API image.

## Step 2: RBAC

Boilerhouse needs permissions to manage pods in its namespace (it creates
tenant instances as pods):

```yaml
# rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: boilerhouse-api
  namespace: <your-namespace>
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: boilerhouse-pod-manager
  namespace: <your-namespace>
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: boilerhouse-api-binding
  namespace: <your-namespace>
subjects:
  - kind: ServiceAccount
    name: boilerhouse-api
roleRef:
  kind: Role
  name: boilerhouse-pod-manager
  apiGroup: rbac.authorization.k8s.io
```

## Step 3: Secrets

```bash
kubectl -n <your-namespace> create secret generic boilerhouse-secrets \
  --from-literal=BOILERHOUSE_SECRET_KEY=$(openssl rand -hex 32)
```

## Step 4: Deploy

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: boilerhouse-api
  namespace: <your-namespace>
spec:
  replicas: 1   # SQLite — single writer only
  selector:
    matchLabels:
      app: boilerhouse-api
  template:
    metadata:
      labels:
        app: boilerhouse-api
    spec:
      serviceAccountName: boilerhouse-api
      containers:
        - name: api
          image: ghcr.io/<org>/boilerhouse-api:latest
          ports:
            - containerPort: 3000
              name: http
            - containerPort: 9464
              name: metrics
          env:
            - name: RUNTIME_TYPE
              value: kubernetes
            - name: K8S_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: LISTEN_HOST
              value: "0.0.0.0"
            - name: PORT
              value: "3000"
            - name: DB_PATH
              value: /data/boilerhouse.db
            - name: STORAGE_PATH
              value: /data
            - name: SNAPSHOT_DIR
              value: /data/snapshots
          envFrom:
            - secretRef:
                name: boilerhouse-secrets
          volumeMounts:
            - name: data
              mountPath: /data
          readinessProbe:
            httpGet:
              path: /api/v1/workloads
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "2"
              memory: 1Gi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: boilerhouse-data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: boilerhouse-data
  namespace: <your-namespace>
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: boilerhouse-api
  namespace: <your-namespace>
spec:
  selector:
    app: boilerhouse-api
  ports:
    - name: http
      port: 3000
      targetPort: 3000
    - name: metrics
      port: 9464
      targetPort: 9464
```

## Step 5: Connect your application

From other pods in the same namespace, reach boilerhouse at:

```
http://boilerhouse-api:3000/api/v1/...
```

Set this as an environment variable in your application deployment:

```yaml
env:
  - name: BOILERHOUSE_URL
    value: "http://boilerhouse-api:3000"
```

## Monitoring

Add a Prometheus ServiceMonitor (if using prometheus-operator):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: boilerhouse
  namespace: <your-namespace>
spec:
  selector:
    matchLabels:
      app: boilerhouse-api
  endpoints:
    - port: metrics
      interval: 15s
```

Or add a static scrape target:
```yaml
- job_name: boilerhouse
  static_configs:
    - targets: ["boilerhouse-api.your-namespace.svc:9464"]
```

## External access (optional)

If you need to expose boilerhouse outside the cluster (e.g. for
webhooks), add an Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: boilerhouse-api
  namespace: <your-namespace>
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: [boilerhouse.yourdomain.com]
      secretName: boilerhouse-tls
  rules:
    - host: boilerhouse.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: boilerhouse-api
                port:
                  name: http
```

## VM vs Kubernetes comparison

| Feature | VM (podman + podmand) | Kubernetes |
|---------|----------------------|------------|
| CRIU checkpoint/restore | Yes | No |
| Instant fork-style provisioning | Yes | No (cold boot) |
| Golden snapshots | Yes | No |
| Host dependencies | podman, criu, bun | None |
| Scaling | Manual | HPA (but SQLite = 1 writer) |
| Envoy sidecars | Yes | Yes |
| Credential injection | Yes | Yes |

## Scaling note

SQLite is single-writer, so `replicas: 1` is required. For horizontal
scaling, boilerhouse would need to migrate to PostgreSQL. A single
replica with adequate CPU/memory handles most workloads.
