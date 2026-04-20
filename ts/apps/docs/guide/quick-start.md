# Quick Start

This guide gets you from zero to a running multi-tenant container in under 10 minutes using a local minikube cluster.

## Prerequisites

- [Go](https://go.dev/) 1.26+
- [Docker](https://docs.docker.com/get-docker/) and [minikube](https://minikube.sigs.k8s.io/)
- [Bun](https://bun.sh/) v1.3+ (for the `kadai` task runner)
- The Boilerhouse repository cloned locally

## 1. Install Dependencies

```bash
cd boilerhouse
bunx kadai run setup
```

This installs Go and TypeScript dependencies plus `setup-envtest` for controller tests.

## 2. Set Up a Local Cluster

```bash
bunx kadai run minikube
```

This creates a minikube profile, installs the four Boilerhouse CRDs, and creates the `boilerhouse` namespace.

Verify the CRDs are installed:

```bash
kubectl get crds | grep boilerhouse
```

```
boilerhouseclaims.boilerhouse.dev
boilerhousepools.boilerhouse.dev
boilerhousetriggers.boilerhouse.dev
boilerhouseworkloads.boilerhouse.dev
```

## 3. Start the Operator and API

```bash
bunx kadai run dev
```

This runs the operator and API server locally against your minikube cluster. The API listens on `http://localhost:3000`. Ctrl+C stops both.

## 4. Apply a Workload

Boilerhouse ships with an example `minimal` workload in `workloads/minimal.yaml`:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: minimal
  namespace: boilerhouse
spec:
  version: "0.1.0"
  image:
    dockerfile: minimal/Dockerfile
  resources:
    vcpus: 1
    memoryMb: 128
    diskGb: 1
  network:
    access: "none"
  idle:
    timeoutSeconds: 300
    action: hibernate
  entrypoint:
    cmd: sh
    args: ["-c", "echo 'minimal container ready' && exec sleep infinity"]
```

Apply it:

```bash
kubectl apply -f workloads/minimal.yaml
```

## 5. Wait for the Workload to be Ready

The operator transitions the workload through `Creating` to `Ready`:

```bash
kubectl get boilerhouseworkloads -n boilerhouse
```

```
NAME      PHASE   VERSION   IMAGE   AGE
minimal   Ready   0.1.0             30s
```

## 6. Claim an Instance

Claim a container for a tenant via the REST API:

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/claim \
  -H "Content-Type: application/json" \
  -d '{"workload": "minimal"}'
```

```json
{
  "tenantId": "alice",
  "phase": "Active",
  "instanceId": "inst-alice-minimal-a1b2c3",
  "endpoint": { "host": "10.244.0.12", "port": 0 },
  "source": "cold",
  "claimedAt": "2026-04-20T10:30:00Z"
}
```

The operator created a `BoilerhouseClaim` resource, which spawned a Pod. You can see both:

```bash
kubectl get boilerhouseclaims -n boilerhouse
kubectl get pods -n boilerhouse -l boilerhouse.dev/managed=true
```

## 7. Interact with the Instance

Run a command inside the container:

```bash
curl -X POST http://localhost:3000/api/v1/instances/<instanceId>/exec \
  -H "Content-Type: application/json" \
  -d '{"command": ["echo", "hello from boilerhouse"]}'
```

```json
{
  "exitCode": 0,
  "stdout": "hello from boilerhouse",
  "stderr": ""
}
```

View container logs:

```bash
curl http://localhost:3000/api/v1/instances/<instanceId>/logs
```

## 8. Release the Tenant

When the tenant is done, release their claim. If the workload has `overlayDirs` configured, the operator extracts and saves the tenant's filesystem state before shutting down the Pod.

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/release \
  -H "Content-Type: application/json" \
  -d '{"workload": "minimal"}'
```

Next time Alice claims the same workload, her filesystem state is restored automatically.

## 9. Enable Pooling

For faster claim times, apply a `BoilerhousePool` resource:

```yaml
# workloads/minimal-pool.yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhousePool
metadata:
  name: minimal-pool
  namespace: boilerhouse
spec:
  workloadRef: minimal
  size: 3
  maxFillConcurrency: 2
```

```bash
kubectl apply -f workloads/minimal-pool.yaml
```

The operator pre-warms 3 Pods. Claims now return in under a second from the pool:

```json
{
  "source": "pool"
}
```

## 10. Tear Down

Delete everything Boilerhouse created in the cluster:

```bash
bunx kadai run nuke
```

## Next Steps

- [Workloads](./workloads) — image sources, resources, health checks, idle policies
- [Tenants & Claims](./tenants) — multi-tenancy model, claim lifecycle
- [Networking & Security](./networking) — network access modes, credential injection
- [Dashboard](./dashboard) — inspect live cluster state in a browser
