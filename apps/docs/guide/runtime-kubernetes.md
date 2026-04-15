# Kubernetes Runtime

The Kubernetes runtime runs each Boilerhouse instance as a Pod in a Kubernetes cluster. It supports both local development via minikube and production deployments on any conformant cluster.

## Setup

### Prerequisites

- A running Kubernetes cluster (minikube, kind, EKS, GKE, AKS, or any conformant distribution)
- `kubectl` installed and configured (required for overlay injection and port-forwarding)
- CRDs installed in the cluster (see [CRD Installation](#crd-installation) below)

### Configuration

Set the runtime type and provide cluster credentials:

```bash
export RUNTIME_TYPE=kubernetes   # also accepts "k8s"
```

Authentication can be configured in three ways:

**Option 1: Explicit credentials**

```bash
export K8S_API_URL=https://your-cluster-api:6443
export K8S_TOKEN=eyJhbG...          # Service account token
export K8S_CA_CERT=/path/to/ca.crt  # Optional, for TLS verification
export K8S_NAMESPACE=boilerhouse    # Default: "boilerhouse"
```

**Option 2: Kubeconfig context**

```bash
export K8S_CONTEXT=my-cluster-context
export K8S_NAMESPACE=boilerhouse
```

When `K8S_CONTEXT` is set, Boilerhouse uses `kubectl` for exec and port-forwarding operations, which is required when pod IPs are not directly routable from the host (e.g., minikube with the Docker driver).

**Option 3: In-cluster (for the operator)**

When running inside a Kubernetes pod (e.g., the Boilerhouse operator), credentials are resolved automatically from the service account token mounted at `/var/run/secrets/kubernetes.io/serviceaccount/`.

### CRD Installation

The Boilerhouse operator manages four Custom Resource Definitions:

| CRD | Short Name | Description |
|---|---|---|
| `BoilerhouseWorkload` | `bhw` | Workload blueprints defining image, resources, and config |
| `BoilerhousePool` | `bhp` | Warm pool configuration for pre-started instances |
| `BoilerhouseClaim` | `bhc` | Tenant-to-instance bindings |
| `BoilerhouseTrigger` | `bht` | Event trigger definitions |

CRDs are installed automatically by the `kadai run minikube` setup script. For manual installation:

```bash
kubectl apply -f apps/operator/crds/
```

## How It Works

### Pod Creation

When a workload instance is created, the Kubernetes runtime:

1. **Resolves the image** -- for pre-built images (`image.ref`), the image reference is passed through to Kubernetes. For Dockerfile-based workloads in minikube, the image is built inside minikube's container runtime.
2. **Creates a Pod** with:
   - Resource requests and limits mapped from `resources.vcpus` and `resources.memory_mb`
   - Security context: all capabilities dropped, privilege escalation disabled, RuntimeDefault seccomp profile
   - `automountServiceAccountToken: false`, `hostNetwork: false`, `hostPID: false`, `hostIPC: false`
   - Labels for identification: `boilerhouse.dev/managed`, `boilerhouse.dev/instance-id`, `boilerhouse.dev/workload-name`
3. **Creates a Service** (ClusterIP) when ports are exposed
4. **Creates a NetworkPolicy** to enforce egress controls based on the workload's `network.access` level

### Port Exposure

Port exposure depends on whether a kubectl context is configured:

- **With context (minikube, remote clusters)**: `kubectl port-forward` maps pod ports to random local ports. This works even when pod IPs are not routable from the host.
- **Without context (in-cluster)**: pod IPs are returned directly, assuming the pod network is routable.

The assigned ports are returned in the claim response endpoint.

### Overlay Injection

Overlays are injected into pods using `kubectl exec`:

```
kubectl -n boilerhouse exec -i <pod> -- tar -xz -C /
```

The tar archive is streamed directly into the pod via stdin. Overlay directories are backed by `emptyDir` volumes with a 256Mi size limit.

### Network Policies

The runtime creates a per-instance `NetworkPolicy` resource that enforces egress controls:

| Access Level | Egress Rules |
|---|---|
| `"none"` | All egress denied |
| `"restricted"` | DNS allowed; HTTPS (port 443) to all IPs except link-local (`169.254.0.0/16`) |
| `"unrestricted"` | DNS allowed; all traffic except link-local |

The link-local range is always blocked to prevent access to cloud metadata servers (e.g., AWS IMDS at `169.254.169.254`).

### Envoy Sidecar

When a workload uses network credentials or `restricted` access mode, an Envoy sidecar container is added to the pod:

- Envoy config is stored in a ConfigMap (`<instanceId>-proxy`)
- The main container gets `HTTP_PROXY` and `http_proxy` environment variables pointing to the sidecar
- The sidecar has its own resource limits (100m CPU, 64Mi memory) and a locked-down security context

### Health Checks

Workload health checks are translated to Kubernetes readiness probes:

- `health.http_get` becomes an `httpGet` readiness probe
- `health.exec` becomes an `exec` readiness probe
- `health.interval_seconds` maps to `periodSeconds`
- `health.unhealthy_threshold` maps to `failureThreshold`

## Minikube Development

For local development, use the included kadai action to set up a minikube cluster:

```bash
bunx kadai run minikube
```

This creates a minikube profile named `boilerhouse-test` with CRDs installed and the image registry configured.

::: tip
Set `K8S_MINIKUBE_PROFILE` to your minikube profile name. When set, the runtime uses `minikube image load` to push locally-built images into minikube's container runtime, and sets `imagePullPolicy: Never` on pods to prevent Kubernetes from trying to pull them from a registry.
:::

```bash
export K8S_MINIKUBE_PROFILE=boilerhouse-test
export K8S_CONTEXT=boilerhouse-test
export K8S_NAMESPACE=boilerhouse
export RUNTIME_TYPE=kubernetes
```

## Leader Election

When running multiple operator replicas, Kubernetes Lease-based leader election ensures only one instance actively reconciles resources. On failover:

1. The new leader acquires the Lease
2. It reconciles all CRD resources against the current cluster state
3. State is recovered from both CRDs and the database

## Differences from Docker

| Aspect | Docker | Kubernetes |
|---|---|---|
| **Startup time** | Fast (sub-second container create) | Slower (pod scheduling, image pull, readiness) |
| **Port exposure** | Direct host port mapping | Port-forward or pod IP |
| **Overlay storage** | Host bind mounts | `emptyDir` volumes |
| **Network isolation** | Docker network modes + iptables | NetworkPolicy resources |
| **Seccomp** | Custom profile via file path | RuntimeDefault profile |
| **Image source** | Local Docker build | Registry pull or minikube image load |
| **Sidecar proxy** | Separate container sharing network namespace | Pod sidecar container |
| **Credential injection** | Envoy MITM with bind-mounted CA cert | Envoy MITM via ConfigMap |

## Related Pages

- [Networking](./networking.md) -- network access modes, credential injection, Envoy sidecar
- [Runtime: Docker](./runtime-docker.md) -- using Docker as the runtime instead
- [Configuration](./configuration.md) -- environment variables reference
