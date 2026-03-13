# Virtual Kubelet + Podman K8s Integration Plan

## Context

The Kubernetes runtime plan (`kubernetes-runtime.md`) adds native K8s pod support to
boilerhouse — but without checkpoint/restore. For users who want **K8s scheduling AND
CRIU checkpoint/restore**, we need a bridge: K8s manages scheduling and the control plane,
while podman+CRIU handles actual container execution on dedicated nodes.

Virtual Kubelet is the established pattern for this. It registers a "virtual node" in K8s
that translates pod lifecycle calls to an external backend. Azure ACI, AWS Fargate, and
HashiCorp Nomad all use this pattern.

This plan depends on the Kubernetes runtime plan being implemented first (specifically,
the `RuntimeCapabilities` changes and the manager capability-aware branching).

## Deployment Architecture

```
K8s Cluster
│
├── Node Pool: "general"               ← standard K8s nodes
│   ├── Boilerhouse API Server           (Deployment)
│   ├── Trigger Adapters                 (Deployment)
│   ├── Virtual Kubelet                  (Deployment)
│   └── VK Web Provider Server           (Deployment, sidecar to VK)
│
└── Node Pool: "boilerhouse"           ← tainted, labeled nodes
    ├── kubelet                          (standard, manages DaemonSets)
    ├── boilerhoused                     (DaemonSet, privileged)
    ├── podman                           (host-installed, OS image)
    ├── CRIU                             (host-installed, OS image)
    └── agent containers                 (managed by podman, invisible to K8s)
```

### Key points

- Boilerhouse nodes are **real K8s nodes** (they run kubelet, appear in `kubectl get nodes`)
- They are **tainted** (`boilerhouse.dev/runtime=podman:NoSchedule`) so normal pods don't
  land on them. Only the boilerhoused DaemonSet tolerates this taint.
- Agent containers run in **podman**, not K8s. K8s has no visibility into them. The Virtual
  Kubelet creates the illusion that pods are running on the virtual node.
- Node pool **autoscaling** works — the cloud provider adds/removes boilerhouse nodes
  based on demand.
- `boilerhoused` registers with the Boilerhouse API on startup (existing behavior).

## Virtual Kubelet Web Provider

Virtual Kubelet requires Go. Instead of writing a full Go provider, we use the **web
provider** pattern: VK forwards pod lifecycle HTTP requests to a TypeScript server that
translates them into boilerhouse API calls.

```
                                    ┌────────────────────┐
K8s API Server ──pod lifecycle──>   │  virtual-kubelet   │
                                    │  (Go binary)       │
                                    │  --provider web    │
                                    │  --web-endpoint    │
                                    │    http://localhost │
                                    └────────┬───────────┘
                                             │ HTTP
                                             ▼
                                    ┌────────────────────┐
                                    │  VK Web Provider   │
                                    │  (TypeScript/Bun)  │
                                    │                    │──HTTP──> Boilerhouse API
                                    └────────────────────┘
```

### VK Web Provider Protocol

The Go VK binary with `--provider web` forwards these HTTP calls:

| VK HTTP call | Boilerhouse API call |
|---|---|
| `POST /createPod` (Pod JSON body) | `POST /api/v1/tenants/:id/claim` (tenant from pod annotation, workload from pod label) |
| `DELETE /deletePod` (Pod JSON body) | `POST /api/v1/tenants/:id/release` |
| `GET /getPod?namespace=X&name=Y` | `GET /api/v1/instances/:id` → translate to Pod JSON |
| `GET /getPodStatus?namespace=X&name=Y` | `GET /api/v1/instances/:id` → Pod status conditions |
| `GET /getPods` | `GET /api/v1/instances` → translate all to Pod JSON |
| `GET /getContainerLogs?namespace=X&name=Y&...` | Proxy to boilerhouse logs endpoint |
| `GET /capacity` | Return node capacity from boilerhouse config |
| `GET /nodeConditions` | Return Ready=True if boilerhouse API is reachable |

### Pod ↔ Boilerhouse Mapping

| K8s concept | Boilerhouse concept | How it maps |
|---|---|---|
| Pod | Instance | 1:1. Pod name = instance ID |
| Namespace | — | All pods go to the configured boilerhouse namespace |
| Pod annotation `boilerhouse.dev/tenant-id` | Tenant ID | Required annotation |
| Pod label `boilerhouse.dev/workload` | Workload name | Required label, looked up by name |
| Pod phase `Pending` | Instance status `starting` | |
| Pod phase `Running` | Instance status `active` | |
| Pod phase `Succeeded` | Instance status `hibernated` | From K8s perspective, pod completed |
| Pod phase `Failed` | Instance status `destroyed` (with error) | |
| Container status | Derived from instance status | |
| PVC | Data overlay | Future: mount tenant data |

### CreatePod Translation

When VK calls `POST /createPod`, the web provider:

1. Extract tenant ID from `pod.metadata.annotations["boilerhouse.dev/tenant-id"]`
2. Extract workload from `pod.metadata.labels["boilerhouse.dev/workload"]`
3. Call `POST /api/v1/tenants/{tenantId}/claim` with `{ workload }`
4. Store the mapping: pod (namespace/name) → instance ID
5. Return success to VK

The workload must already exist in boilerhouse. The pod spec's container image, resources,
etc. are **ignored** — the boilerhouse workload definition is authoritative. The pod spec
is a scheduling hint only.

### DeletePod Translation

When VK calls `DELETE /deletePod`:

1. Look up tenant ID from pod annotation
2. Call `POST /api/v1/tenants/{tenantId}/release`
3. Boilerhouse applies the workload's idle policy (hibernate if podman, destroy if K8s-only)
4. Remove the pod mapping
5. Return success to VK

## Package Structure

```
apps/virtual-kubelet-provider/
  package.json          @boilerhouse/virtual-kubelet-provider
  tsconfig.json
  src/
    index.ts            entry point — Bun.serve()
    server.ts           HTTP handlers for VK web provider protocol
    translator.ts       Pod JSON ↔ boilerhouse API call translation
    pod-store.ts        in-memory map of pod (ns/name) → instance state
    types.ts            VK web provider request/response types
    translator.test.ts
    server.test.ts
  deploy/
    virtual-kubelet.yaml     K8s manifests: Deployment + RBAC
    boilerhoused.yaml        DaemonSet for boilerhouse nodes
    node-pool-taint.yaml     Taint/label config for boilerhouse nodes
```

Dependencies: `@boilerhouse/core: "workspace:*"` only.

### VK Web Provider Server

```typescript
Bun.serve({
  port: Number(process.env.PORT ?? 3002),
  routes: {
    "/createPod": { POST: handleCreatePod },
    "/deletePod": { DELETE: handleDeletePod },
    "/getPod": { GET: handleGetPod },
    "/getPodStatus": { GET: handleGetPodStatus },
    "/getPods": { GET: handleGetPods },
    "/getContainerLogs": { GET: handleGetContainerLogs },
    "/capacity": { GET: handleCapacity },
    "/nodeConditions": { GET: handleNodeConditions },
  },
});
```

### Pod Store

In-memory map tracking active pods. Reconstructed on startup by querying the boilerhouse
API for all active instances.

```typescript
class PodStore {
  private pods = new Map<string, PodRecord>();  // key: "namespace/name"

  add(namespace: string, name: string, record: PodRecord): void
  remove(namespace: string, name: string): void
  get(namespace: string, name: string): PodRecord | undefined
  getAll(): PodRecord[]

  /** Reconcile with boilerhouse API on startup. */
  async sync(client: BoilerhouseClient): Promise<void>
}

interface PodRecord {
  instanceId: InstanceId;
  tenantId: TenantId;
  workloadName: string;
  createdAt: Date;
}
```

## Deployment Manifests

### Virtual Kubelet Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: boilerhouse-virtual-kubelet
  namespace: boilerhouse-system
spec:
  replicas: 1
  template:
    spec:
      serviceAccountName: virtual-kubelet
      containers:
        # Go VK binary
        - name: virtual-kubelet
          image: virtual-kubelet/virtual-kubelet:latest
          args:
            - --provider=web
            - --web-endpoint=http://localhost:3002
            - --nodename=boilerhouse-vk
            - --startup-timeout=30s
          env:
            - name: KUBELET_PORT
              value: "10250"
        # TypeScript web provider server
        - name: provider
          image: boilerhouse/vk-provider:latest
          ports:
            - containerPort: 3002
          env:
            - name: BOILERHOUSE_API_URL
              value: "http://boilerhouse-api.boilerhouse.svc:3000"
            - name: PORT
              value: "3002"
```

### RBAC

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: virtual-kubelet
  namespace: boilerhouse-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: virtual-kubelet
rules:
  - apiGroups: [""]
    resources: ["nodes", "nodes/status"]
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods", "pods/status"]
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"]
```

### Boilerhoused DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: boilerhoused
  namespace: boilerhouse-system
spec:
  selector:
    matchLabels:
      app: boilerhoused
  template:
    spec:
      tolerations:
        - key: boilerhouse.dev/runtime
          operator: Equal
          value: podman
          effect: NoSchedule
      nodeSelector:
        boilerhouse.dev/runtime: podman
      hostPID: true
      hostNetwork: true
      containers:
        - name: boilerhoused
          image: boilerhouse/boilerhoused:latest
          securityContext:
            privileged: true
          volumeMounts:
            - name: podman-socket
              mountPath: /var/run/podman
            - name: snapshots
              mountPath: /var/lib/boilerhouse/snapshots
      volumes:
        - name: podman-socket
          hostPath:
            path: /var/run/podman
        - name: snapshots
          hostPath:
            path: /var/lib/boilerhouse/snapshots
```

## Testing

### Unit tests

**`translator.test.ts`**:
- Pod JSON with tenant annotation + workload label → correct API calls
- Pod JSON missing required annotation → error
- Instance status → Pod phase mapping
- Instance list → Pod list JSON

**`server.test.ts`**:
- Mock boilerhouse API with local HTTP server
- Test each VK endpoint: createPod, deletePod, getPod, getPods, getPodStatus
- Test capacity and nodeConditions responses
- Test error propagation (boilerhouse API down, claim fails)

### Integration tests

Integration testing is the hardest part. Three levels:

**Level 1: Mock VK (no real K8s)**
- Start the TypeScript web provider server
- Start a boilerhouse API with FakeRuntime
- Send HTTP requests mimicking what VK would send
- Verify correct boilerhouse API calls and responses

This runs in CI with no special infrastructure.

**Level 2: Kind cluster + VK binary**
- Start a kind cluster
- Deploy the VK binary + web provider server
- Deploy boilerhouse API with FakeRuntime (as a pod in kind)
- `kubectl apply` a test pod with the VK nodeSelector
- Verify: pod transitions to Running, boilerhouse shows an active instance
- Delete the pod, verify cleanup

Requires: kind in CI, VK binary built, container images built.

**Level 3: Kind + real podman nodes**
- Same as Level 2 but with actual podman+CRIU on a node
- Test checkpoint/restore through the full stack
- Requires privileged containers or a VM-based CI environment

For initial development, Level 1 is sufficient. Level 2 for CI. Level 3 is manual/nightly.

### How to run tests

```sh
# Level 1: unit + mock integration (no cluster)
bun test apps/virtual-kubelet-provider/src/

# Level 2: kind cluster (CI)
BOILERHOUSE_VK_E2E=true bun test apps/virtual-kubelet-provider/src/e2e/ --timeout 120000

# Level 3: full stack (manual)
BOILERHOUSE_VK_E2E=true BOILERHOUSE_CRIU_AVAILABLE=true \
  bun test apps/virtual-kubelet-provider/src/e2e/ --timeout 120000
```

## Implementation Order

1. `types.ts` — VK web provider request/response types
2. `translator.ts` + `translator.test.ts` — Pod ↔ boilerhouse translation
3. `pod-store.ts` — in-memory pod tracking
4. `server.ts` + `server.test.ts` — HTTP handlers (test with mock boilerhouse)
5. `index.ts` — entry point
6. `deploy/` — K8s manifests
7. Level 1 integration test
8. Level 2 integration test (kind cluster)

## Open Questions

1. **VK binary version**: Which version of the virtual-kubelet Go binary should we pin to?
   Need to verify the web provider protocol is stable.

2. **Multi-node scheduling**: The current boilerhouse API server runs with a single node.
   When multiple boilerhouse nodes are available (multiple boilerhoused DaemonSet pods),
   the API server needs a way to pick which node handles the claim. This may require a
   scheduler component or round-robin logic in the API server. Out of scope for this plan
   but needed before production.

3. **Pod spec passthrough**: Should we support overriding boilerhouse workload fields via
   pod spec (e.g., different env vars per pod)? Currently the pod spec is ignored — the
   workload definition is authoritative. This simplifies the provider but limits
   flexibility.

4. **Hibernation visibility**: When an agent hibernates, we map it to Pod phase `Succeeded`.
   This means K8s considers the pod finished. On the next claim, a new pod is created.
   Alternative: keep the pod in a custom condition and prevent K8s from garbage collecting
   it. This needs more thought.
