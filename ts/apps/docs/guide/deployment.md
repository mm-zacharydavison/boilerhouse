# Deployment

Boilerhouse can be deployed as a standalone binary, a Docker container, a systemd service, or a Kubernetes operator.

## API Server (Single Binary)

Build a standalone binary using Bun:

```bash
bun build apps/api/src/main.ts --compile --outfile boilerhouse-api
```

Run it:

```bash
export BOILERHOUSE_SECRET_KEY=your-secret
export RUNTIME_TYPE=docker
./boilerhouse-api
```

The binary is self-contained — no Node.js or Bun runtime needed on the target machine.

## API Server (Docker)

Build the Docker image:

```bash
docker build -t boilerhouse-api .
```

Run with Docker socket mounted:

```bash
docker run -d \
  -p 3000:3000 \
  -p 9464:9464 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ./data:/app/data \
  -e BOILERHOUSE_SECRET_KEY=your-secret \
  -e STORAGE_PATH=/app/data \
  boilerhouse-api
```

The Docker socket mount is required for the Docker runtime to manage containers.

## API Server (systemd)

Install as a systemd service using the CLI:

```bash
boilerhouse api install \
  --binary-path /usr/local/bin/boilerhouse \
  --data-dir /var/lib/boilerhouse
```

This creates a systemd unit at `/etc/systemd/system/boilerhouse.service`.

Manage the service:

```bash
sudo systemctl start boilerhouse
sudo systemctl stop boilerhouse
sudo systemctl status boilerhouse
sudo journalctl -u boilerhouse -f
```

## Kubernetes Operator

### Prerequisites

- Kubernetes 1.26+ cluster
- `kubectl` with cluster-admin access
- Container registry for operator and workload images

### Install CRDs

```bash
kubectl apply -f apps/operator/crds/
```

### Deploy the Operator

Create the namespace and deployment:

```bash
kubectl create namespace boilerhouse

kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: boilerhouse-operator
  namespace: boilerhouse
spec:
  replicas: 2  # HA with leader election
  selector:
    matchLabels:
      app: boilerhouse-operator
  template:
    metadata:
      labels:
        app: boilerhouse-operator
    spec:
      serviceAccountName: boilerhouse-operator
      containers:
        - name: operator
          image: boilerhouse-operator:latest
          env:
            - name: BOILERHOUSE_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: boilerhouse-secrets
                  key: secret-key
            - name: S3_ENABLED
              value: "true"
            - name: S3_BUCKET
              value: boilerhouse-overlays
          ports:
            - containerPort: 9090
              name: health
          readinessProbe:
            httpGet:
              path: /healthz
              port: 9090
EOF
```

### Create RBAC

The operator needs permissions to manage Pods, Services, ConfigMaps, NetworkPolicies, Leases, and Boilerhouse CRDs. Create a ClusterRole and bind it to the operator's service account.

### High Availability

Deploy with 2+ replicas. The operator uses Kubernetes Lease-based leader election — only one replica reconciles at a time, others are on standby.

## Production Checklist

### Security

- [ ] Set `BOILERHOUSE_SECRET_KEY` to a strong random value (used for overlay encryption and secret storage)
- [ ] Set `BOILERHOUSE_API_KEY` for API authentication
- [ ] Configure seccomp profiles (`SECCOMP_PROFILE_PATH`) for container hardening
- [ ] Use `restricted` network access for untrusted workloads
- [ ] Store secrets in a proper secret manager (K8s Secrets, AWS Secrets Manager)

### Storage

- [ ] Enable S3 storage for overlay durability (`S3_ENABLED=true`)
- [ ] Configure local cache size (`OVERLAY_CACHE_MAX_BYTES`)
- [ ] Back up the SQLite database (or mount a persistent volume for the operator)

### Observability

- [ ] Set up Prometheus to scrape `METRICS_PORT`
- [ ] Configure OTLP export for distributed tracing
- [ ] Set `LOG_LEVEL=info` for production
- [ ] Monitor key metrics:
  - `boilerhouse.pool.depth` — pool health
  - `boilerhouse.tenant.claim.duration` — claim latency
  - `boilerhouse.instances` — instance count by status
  - `boilerhouse.node.capacity.used` — capacity utilization

### Resources

- [ ] Set `MAX_INSTANCES` appropriate for your host/node capacity
- [ ] Size workload resources (CPU, memory, disk) appropriately
- [ ] Configure pool sizes based on expected concurrency
- [ ] Set `max_fill_concurrency` to avoid overwhelming the host during pool refill

### Networking

- [ ] Configure domain allowlists for restricted workloads
- [ ] Set up credential injection for API keys
- [ ] Block metadata endpoints (automatic for Docker/K8s)
- [ ] Configure CORS origins if running the dashboard

### Updates

The CLI supports self-update:

```bash
boilerhouse update
```

For Docker deployments, pull the latest image. For Kubernetes, update the operator Deployment image tag.
