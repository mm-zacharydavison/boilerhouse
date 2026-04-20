# Dashboard "kubernetes" debug page

## Motivation

The dashboard exposes Boilerhouse CRDs through opinionated, shaped responses (Workloads, Instances, Triggers). When something goes wrong — a Pod stuck Pending, a NetworkPolicy not matching, a PVC in the wrong state — there is no way to inspect the raw cluster objects without dropping to `kubectl`. Operators debugging locally or in a deployed cluster need an at-a-glance view of every Boilerhouse-managed resource in the namespace.

## Scope

Add a new sidebar page called **kubernetes** to the dashboard that lists all Boilerhouse-managed resources in the operator's namespace, grouped by kind, with raw JSON available on click. Data is fetched from a new Go API endpoint and refreshed every 3 seconds while the page is visible.

### Resources shown

| Kind | Source |
| --- | --- |
| Workload | CRD |
| Pool | CRD |
| Claim | CRD |
| Trigger | CRD |
| Pod | native |
| PersistentVolumeClaim | native |
| Service | native |
| NetworkPolicy | native |

Native objects are filtered by the label `app.kubernetes.io/managed-by=boilerhouse`. CRDs are listed without a label filter (the CRD itself implies ownership).

### Non-goals

- Events, ConfigMaps, Secrets, Endpoints, or any other resource kind.
- Cross-namespace views.
- Editing, deleting, or exec-ing from this page.
- WebSocket live streaming (polling is sufficient).
- Gating behind a dev/debug flag — the nav item is always visible.

## Operator change: managed-by label

The operator must stamp `app.kubernetes.io/managed-by=boilerhouse` on every object it creates:

- Pods built by `go/internal/operator/translator.go`.
- PVCs, Services, and NetworkPolicies built by the Workload and Pool controllers.

Add the label alongside existing labels (do not replace them). The controllers should include the label in their ownership filters when listing resources during reconciliation only if they already filter by label — otherwise leave listing logic alone. The label's purpose here is purely to let external consumers (this debug endpoint, `kubectl get ... -l ...`) identify Boilerhouse-owned objects.

## Backend

### Endpoint

`GET /api/v1/debug/resources`

Response shape:

```json
{
  "workloads":              [ResourceEntry, ...],
  "pools":                  [ResourceEntry, ...],
  "claims":                 [ResourceEntry, ...],
  "triggers":               [ResourceEntry, ...],
  "pods":                   [ResourceEntry, ...],
  "persistentVolumeClaims": [ResourceEntry, ...],
  "services":               [ResourceEntry, ...],
  "networkPolicies":        [ResourceEntry, ...]
}
```

Where `ResourceEntry` is:

```go
type ResourceEntry struct {
    Name    string          `json:"name"`
    Phase   string          `json:"phase"`   // "" if not applicable (e.g. Service, NetworkPolicy)
    Age     string          `json:"age"`     // human-friendly, e.g. "2m", "3h15m"
    Summary map[string]any  `json:"summary"` // per-kind key fields, see below
    Raw     json.RawMessage `json:"raw"`     // full K8s object as returned by the client
}
```

Per-kind `summary` fields (used to render row columns on the frontend):

- **Workload**: `image`, `version`
- **Pool**: `workloadRef`, `desired`, `ready`
- **Claim**: `tenant`, `instance`, `workloadRef`
- **Trigger**: `type`, `workloadRef`
- **Pod**: `node`, `podIP`, `tenant` (from labels if present)
- **PersistentVolumeClaim**: `storageClass`, `capacity`
- **Service**: `type`, `clusterIP`, `ports` (short string)
- **NetworkPolicy**: `podSelector` (summarized as a short string)

### Implementation

- New file `go/internal/api/routes_debug.go` with a single handler `handleListResources`.
- Wire the route in the existing chi router under `/debug/resources`.
- Use the same controller-runtime client already injected into other handlers.
- Namespace comes from `K8S_NAMESPACE` env (the value already used elsewhere).
- Fetch all eight kinds in parallel with `errgroup`. If one kind fails, the whole request fails with a 500 and the first error — this is a debug endpoint and partial results would be misleading.
- Filter native kinds with `client.MatchingLabels{"app.kubernetes.io/managed-by": "boilerhouse"}`.
- `Raw` is populated by marshaling the typed object back to JSON; no masking of Secrets is needed because Secrets are not included.

### Testing

One envtest-based test in `go/internal/api/routes_debug_test.go`:

- Create one of each kind (the four CRDs plus a labeled Pod, PVC, Service, and NetworkPolicy).
- Hit the endpoint, assert the response contains eight non-empty groups with the expected counts and the expected summary fields.
- Also create one unlabeled Pod to confirm it is excluded.

## Frontend

### Routing & navigation

- Add `{ path: "/kubernetes", label: "kubernetes", icon: Boxes }` to `NAV_ITEMS` in `ts/apps/dashboard/src/app.tsx`.
- Route `/kubernetes` renders a new `<Kubernetes />` page. No params.

### Page component

New file `ts/apps/dashboard/src/pages/Kubernetes.tsx`:

- On mount, fetches `GET /api/v1/debug/resources` via a new `api.fetchDebugResources()` method in `api.ts`.
- Polls every 3 seconds using `setInterval` inside a `useEffect`. The interval is paused when `document.visibilityState !== "visible"`, using a `visibilitychange` listener.
- Header: page title, a refresh button, and a "last refreshed Ns ago" counter that ticks locally every second.
- Below the header, one section per kind rendered in the order listed above. Each section:
  - Collapsible header showing the kind name and `(n)` count. Expanded by default; collapsed state is session-local only (no persistence).
  - A table with per-kind columns. Columns per kind:
    - **Workload**: name, phase, image, age
    - **Pool**: name, phase, size (`ready/desired`), age
    - **Claim**: name, phase, tenant, instance, age
    - **Trigger**: name, phase, type, workloadRef, age
    - **Pod**: name, phase, node, podIP, age
    - **PersistentVolumeClaim**: name, phase, storageClass, capacity, age
    - **Service**: name, type, clusterIP, ports, age
    - **NetworkPolicy**: name, podSelector, age
  - Clicking a row toggles an inline expanded panel beneath it that renders `entry.raw` with the existing `json-syntax.tsx` pretty-printer.
  - Empty sections render as a muted "no resources".

### Types

Add to `api.ts`:

```ts
export interface DebugResourceEntry {
  name: string;
  phase: string;
  age: string;
  summary: Record<string, unknown>;
  raw: unknown;
}

export interface DebugResourcesResponse {
  workloads: DebugResourceEntry[];
  pools: DebugResourceEntry[];
  claims: DebugResourceEntry[];
  triggers: DebugResourceEntry[];
  pods: DebugResourceEntry[];
  persistentVolumeClaims: DebugResourceEntry[];
  services: DebugResourceEntry[];
  networkPolicies: DebugResourceEntry[];
}
```

And `api.fetchDebugResources = () => get<DebugResourcesResponse>("/debug/resources");`.

### Error handling

- A failed fetch renders a red banner at the top of the page with the error message. Previously loaded data remains visible underneath (do not blank the page on transient errors).
- If the endpoint returns 404 (older API binary), the banner says "this API server does not support /debug/resources" and polling stops.

### Frontend testing

The dashboard has no existing test infrastructure. Skip frontend tests; the envtest backend test is sufficient to guarantee the contract.

## File-level changes

- **New**:
  - `go/internal/api/routes_debug.go`
  - `go/internal/api/routes_debug_test.go`
  - `ts/apps/dashboard/src/pages/Kubernetes.tsx`
- **Modified**:
  - `go/internal/api/routes.go` (or wherever routes are wired) — register `/debug/resources`.
  - `go/internal/operator/translator.go` — add managed-by label to Pod spec.
  - `go/internal/operator/pool_controller.go`, `claim_controller.go`, `workload_controller.go` — add the label to any PVCs/Services/NetworkPolicies they create.
  - `ts/apps/dashboard/src/app.tsx` — add nav item and route.
  - `ts/apps/dashboard/src/api.ts` — add `DebugResourcesResponse` types and `fetchDebugResources`.
