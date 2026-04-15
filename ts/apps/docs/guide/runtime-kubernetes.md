# Kubernetes Operator

The Kubernetes runtime deploys Boilerhouse as a native Kubernetes operator. Workloads, pools, and claims are managed as Custom Resources.

## Overview

The operator watches four Custom Resource types:

| CRD | Purpose |
|-----|---------|
| `BoilerhouseWorkload` | Defines a container workload (image, resources, network, etc.) |
| `BoilerhousePool` | Maintains a pre-warmed pool of instances for a workload |
| `BoilerhouseClaim` | Represents a tenant's claim on an instance |
| `BoilerhouseTrigger` | Connects external events to tenant claims |

These are fully declarative — you create YAML manifests, and the operator reconciles them into running Pods, Services, and NetworkPolicies.

## Setup

### Cluster Requirements

- Kubernetes 1.26+
- `kubectl` access with cluster-admin permissions (for CRD installation)
- A namespace for Boilerhouse resources (default: `boilerhouse`)

### Install CRDs

Apply the Custom Resource Definitions:

```bash
kubectl apply -f apps/operator/crds/
```

This installs four CRDs:
- `boilerhouseworkloads.boilerhouse.dev`
- `boilerhousepools.boilerhouse.dev`
- `boilerhouseclaims.boilerhouse.dev`
- `boilerhousetriggers.boilerhouse.dev`

### Deploy the Operator

The operator runs as a Deployment in your cluster:

```bash
kubectl create namespace boilerhouse
kubectl apply -f deploy/operator.yaml
```

The operator needs permissions to:
- Watch and manage Pods, Services, ConfigMaps, NetworkPolicies
- Watch and update status on Boilerhouse CRDs
- Create and manage Leases (for leader election)
- Read Secrets (for credential injection)

### Authentication

The operator supports three authentication modes:

| Mode | Configuration |
|------|--------------|
| **In-cluster** | Automatic when running as a Pod (uses service account token) |
| **Token** | `K8S_API_URL` + `K8S_TOKEN` + optional `K8S_CA_CERT` |
| **Kubeconfig** | `K8S_CONTEXT` to select a kubectl context |

For development, kubeconfig is the easiest:

```bash
export K8S_CONTEXT=minikube
```

## Creating Workloads

Define a workload as a Kubernetes resource:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: my-agent
  namespace: boilerhouse
spec:
  version: "1.0.0"
  image:
    ref: my-registry/my-agent:latest
  resources:
    vcpus: 2
    memoryMb: 2048
    diskGb: 10
  network:
    access: restricted
    allowlist:
      - api.openai.com
      - registry.npmjs.org
    expose:
      - guest: 8080
        hostRange: [30000, 30099]
  filesystem:
    overlayDirs:
      - /workspace
    encryptOverlays: true
  idle:
    timeoutSeconds: 300
    action: hibernate
  health:
    intervalSeconds: 5
    unhealthyThreshold: 10
    httpGet:
      path: /health
      port: 8080
  entrypoint:
    cmd: node
    args: ["server.js"]
    workdir: /app
    env:
      NODE_ENV: production
```

The operator validates the spec, stores the workload in its database, and transitions it to `Ready`:

```bash
kubectl get boilerhouseworkloads -n boilerhouse
```

```
NAME       VERSION   STATUS   AGE
my-agent   1.0.0     Ready    2m
```

## Creating Pools

Pools are separate resources that reference a workload:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhousePool
metadata:
  name: my-agent-pool
  namespace: boilerhouse
spec:
  workloadRef: my-agent
  size: 5
  maxFillConcurrency: 3
```

The operator creates Pods to fill the pool:

```bash
kubectl get boilerhousepools -n boilerhouse
```

```
NAME            WORKLOAD   SIZE   READY   PHASE
my-agent-pool   my-agent   5      5       Healthy
```

## Creating Claims

Claims allocate instances to tenants:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseClaim
metadata:
  name: alice-my-agent
  namespace: boilerhouse
spec:
  tenantId: alice
  workloadRef: my-agent
  resume: true
```

The `resume: true` flag tells Boilerhouse to restore the tenant's previous overlay data if available.

```bash
kubectl get boilerhouseclaims -n boilerhouse
```

```
NAME              TENANT   WORKLOAD   PHASE    SOURCE   ENDPOINT
alice-my-agent    alice    my-agent   Active   pool     10.0.0.5:8080
```

The claim status includes:

```yaml
status:
  phase: Active
  instanceId: inst_abc123
  source: pool+data
  endpoint:
    host: 10.0.0.5
    port: 8080
  claimedAt: "2024-01-15T10:30:00Z"
```

To release a claim, delete the resource:

```bash
kubectl delete boilerhouseclaim alice-my-agent -n boilerhouse
```

The operator extracts overlays, hibernates the instance, and replenishes the pool.

## How the Operator Translates Workloads

The operator translates workload specs into Kubernetes resources:

### Pod

Each instance becomes a Pod with:
- Container image and entrypoint from the workload spec
- CPU/memory resource requests and limits
- Readiness probe from the health check config
- `emptyDir` volumes for overlay directories
- Security context: `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, all capabilities dropped
- Labels: `boilerhouse.dev/managed=true`, `boilerhouse.dev/workload=<name>`, `boilerhouse.dev/instance=<id>`

### Service

If the workload exposes ports, a ClusterIP Service is created:
- Named `svc-<instanceId>` (truncated to DNS-1035 compliance)
- Maps `guest` ports to the Pod

### NetworkPolicy

Egress rules based on `network.access`:

| Access | Egress Policy |
|--------|--------------|
| `none` | Deny all egress |
| `restricted` | Allow DNS (port 53) + HTTPS (port 443) only. Block link-local (169.254.0.0/16). |
| `unrestricted` | Allow all except link-local (169.254.0.0/16) |

### Envoy Sidecar

For workloads with `restricted` access and `credentials`, an Envoy sidecar container is added to the Pod. A ConfigMap holds the Envoy configuration and TLS certificates for MITM credential injection.

## Leader Election

The operator uses Kubernetes Lease-based leader election for high availability. Only the leader reconciles resources — other replicas are standby.

Configure with environment variables:
- `LEADER_ELECTION_NAMESPACE` — namespace for the Lease resource
- `LEADER_ELECTION_NAME` — name of the Lease

## Crash Recovery

On startup (or leader election win), the operator:

1. Queries the database for instances that should be running
2. Lists actual Pods in the cluster
3. Reconciles: marks missing instances as destroyed, cleans up stale claims
4. Resumes idle monitors for active instances

This ensures consistent state after operator restarts.

## Minikube Development

For local development, use minikube with the `boilerhouse-test` profile:

```bash
# Set up the minikube cluster
bunx kadai run minikube

# Configure the operator to use minikube
export K8S_MINIKUBE_PROFILE=boilerhouse-test
```

When a minikube profile is configured:
- Images are built inside minikube's Docker daemon (no registry needed)
- Port forwarding is used for endpoint access (`kubectl port-forward`)
- The operator creates temporary port-forward processes for each claimed instance

## Differences from Docker

| Feature | Docker | Kubernetes |
|---------|--------|------------|
| Image source | Dockerfile or registry | Registry only (minikube uses local build) |
| Port exposure | Host port mapping | ClusterIP Service + port-forward (minikube) or LoadBalancer |
| Network isolation | Docker network modes + iptables | NetworkPolicy resources |
| Overlay extraction | Bind mount tar | `kubectl exec` tar + base64 |
| Pause/unpause | Docker pause | Not supported (destroy and recreate) |
| Multi-node | Single host | Multi-node cluster |
| Pool management | API server manages | Operator + CRD reconciliation |
| Scaling | Manual `MAX_INSTANCES` | K8s resource quotas + node autoscaling |

## Full CRD Reference

See [CRD Reference](../reference/crds) for the complete specification of all Custom Resource types.
