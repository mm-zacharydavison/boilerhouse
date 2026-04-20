# Dashboard Kubernetes Debug Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/kubernetes` page to the dashboard that shows every Boilerhouse-managed K8s resource in the operator's namespace, grouped by kind, with raw JSON on click, auto-refreshing every 3s.

**Architecture:** One new Go API endpoint `GET /api/v1/debug/resources` using the existing controller-runtime client + `errgroup` to list eight resource kinds in parallel (4 CRDs + Pod/PVC/Service/NetworkPolicy filtered by `boilerhouse.dev/managed=true`). Dashboard adds a new nav item and page that polls the endpoint via the existing `useApi` + `useAutoRefresh` hooks and renders each kind as a collapsible table with per-row expand-to-JSON.

**Tech Stack:** Go 1.26, go-chi, controller-runtime, `sigs.k8s.io/controller-runtime/pkg/envtest`, `golang.org/x/sync/errgroup` (already in go.sum), React + TypeScript, existing `json-syntax.tsx` pretty-printer.

---

## File Structure

- **New**
  - `go/internal/api/routes_debug.go` — the handler, the per-kind summary builders, and `ResourceEntry` type.
  - `go/internal/api/routes_debug_test.go` — envtest-based test.
  - `ts/apps/dashboard/src/pages/Kubernetes.tsx` — the page component.
- **Modified**
  - `go/internal/api/server.go` — register the route.
  - `ts/apps/dashboard/src/api.ts` — add types + `fetchDebugResources()`.
  - `ts/apps/dashboard/src/app.tsx` — add nav item + route wiring.

---

## Task 1: Backend — `ResourceEntry` type and skeleton handler

**Files:**
- Create: `go/internal/api/routes_debug.go`
- Modify: `go/internal/api/server.go`

- [ ] **Step 1: Create `routes_debug.go` with the types and an empty handler**

Create `go/internal/api/routes_debug.go`:

```go
package api

import (
	"encoding/json"
	"net/http"
)

// resourceEntry is the JSON shape for a single object in the debug/resources
// response. Phase is empty for kinds that don't have one (Service,
// NetworkPolicy). Summary holds a small per-kind set of fields used by the
// dashboard to populate row columns. Raw is the full K8s object as returned
// by the controller-runtime client, marshaled back to JSON.
type resourceEntry struct {
	Name    string          `json:"name"`
	Phase   string          `json:"phase"`
	Age     string          `json:"age"`
	Summary map[string]any  `json:"summary"`
	Raw     json.RawMessage `json:"raw"`
}

// debugResourcesResponse is the JSON shape returned by GET /debug/resources.
type debugResourcesResponse struct {
	Workloads              []resourceEntry `json:"workloads"`
	Pools                  []resourceEntry `json:"pools"`
	Claims                 []resourceEntry `json:"claims"`
	Triggers               []resourceEntry `json:"triggers"`
	Pods                   []resourceEntry `json:"pods"`
	PersistentVolumeClaims []resourceEntry `json:"persistentVolumeClaims"`
	Services               []resourceEntry `json:"services"`
	NetworkPolicies        []resourceEntry `json:"networkPolicies"`
}

func (s *Server) listDebugResources(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, debugResourcesResponse{})
}
```

- [ ] **Step 2: Register the route**

In `go/internal/api/server.go`, inside the authenticated group right after the existing trigger routes (after line `r.Delete("/triggers/{id}", s.deleteTrigger)`), add:

```go
			// Debug
			r.Get("/debug/resources", s.listDebugResources)
```

- [ ] **Step 3: Build**

Run: `cd go && go build ./...`
Expected: builds cleanly.

- [ ] **Step 4: Commit**

```bash
git add go/internal/api/routes_debug.go go/internal/api/server.go
git commit -m "api: scaffold /debug/resources endpoint"
```

---

## Task 2: Backend — age helper

**Files:**
- Modify: `go/internal/api/routes_debug.go`

- [ ] **Step 1: Add the age helper at the bottom of `routes_debug.go`**

Append to `go/internal/api/routes_debug.go`:

```go
import-block is already present near the top; extend it with "fmt" and "time" and "metav1 \"k8s.io/apimachinery/pkg/apis/meta/v1\""
```

(This is a reminder to update the import block — do that when you paste the code below, which references `time` and `metav1`.)

Add at the bottom of the file:

```go
// formatAge returns a short human-friendly duration like "3m", "2h15m", "5d".
// Returns "" if ts is zero.
func formatAge(ts metav1.Time) string {
	if ts.IsZero() {
		return ""
	}
	d := time.Since(ts.Time)
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		h := int(d.Hours())
		m := int(d.Minutes()) - h*60
		if m == 0 {
			return fmt.Sprintf("%dh", h)
		}
		return fmt.Sprintf("%dh%dm", h, m)
	}
	days := int(d.Hours()) / 24
	h := int(d.Hours()) - days*24
	if h == 0 {
		return fmt.Sprintf("%dd", days)
	}
	return fmt.Sprintf("%dd%dh", days, h)
}
```

Update the import block at the top of the file so it reads:

```go
import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)
```

- [ ] **Step 2: Build**

Run: `cd go && go build ./...`
Expected: builds cleanly.

- [ ] **Step 3: Commit**

```bash
git add go/internal/api/routes_debug.go
git commit -m "api: add formatAge helper for debug/resources"
```

---

## Task 3: Backend — test scaffold with fixtures (fails first)

**Files:**
- Create: `go/internal/api/routes_debug_test.go`

- [ ] **Step 1: Write the failing test**

Create `go/internal/api/routes_debug_test.go`:

```go
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestListDebugResources(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	ns := srv.namespace
	ctx := t.Context()

	// One of each CRD.
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-1", Namespace: ns},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image:   v1alpha1.ImageSpec{Ref: "busybox:latest"},
			Resources: v1alpha1.ResourceSpec{Vcpus: 1, MemoryMb: 128, DiskGb: 1},
		},
	}))
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhousePool{
		ObjectMeta: metav1.ObjectMeta{Name: "pool-1", Namespace: ns},
		Spec:       v1alpha1.BoilerhousePoolSpec{WorkloadRef: "wl-1", Size: 2},
	}))
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "claim-1", Namespace: ns},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "tenant-a", WorkloadRef: "wl-1"},
	}))
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "trg-1", Namespace: ns},
		Spec:       v1alpha1.BoilerhouseTriggerSpec{Type: "webhook", WorkloadRef: "wl-1"},
	}))

	// Native objects: one labeled (included), one unlabeled (excluded for Pod).
	managedLabels := map[string]string{"boilerhouse.dev/managed": "true"}

	require.NoError(t, srv.client.Create(ctx, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-managed", Namespace: ns, Labels: managedLabels},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "c", Image: "busybox:latest"}},
		},
	}))
	require.NoError(t, srv.client.Create(ctx, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-unmanaged", Namespace: ns},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "c", Image: "busybox:latest"}},
		},
	}))

	require.NoError(t, srv.client.Create(ctx, &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "pvc-1", Namespace: ns, Labels: managedLabels},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse("1Gi"),
				},
			},
		},
	}))

	require.NoError(t, srv.client.Create(ctx, &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "svc-1", Namespace: ns, Labels: managedLabels},
		Spec: corev1.ServiceSpec{
			Type:  corev1.ServiceTypeClusterIP,
			Ports: []corev1.ServicePort{{Port: 80, TargetPort: intFromInt32(80)}},
		},
	}))

	require.NoError(t, srv.client.Create(ctx, &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: "np-1", Namespace: ns, Labels: managedLabels},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "x"}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
		},
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/debug/resources", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var resp debugResourcesResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))

	assert.Len(t, resp.Workloads, 1)
	assert.Len(t, resp.Pools, 1)
	assert.Len(t, resp.Claims, 1)
	assert.Len(t, resp.Triggers, 1)
	assert.Len(t, resp.Pods, 1, "only labeled Pod should be included")
	assert.Equal(t, "pod-managed", resp.Pods[0].Name)
	assert.Len(t, resp.PersistentVolumeClaims, 1)
	assert.Len(t, resp.Services, 1)
	assert.Len(t, resp.NetworkPolicies, 1)

	// Workload summary should carry image.
	assert.Equal(t, "busybox:latest", resp.Workloads[0].Summary["image"])
	// Claim summary should carry tenant.
	assert.Equal(t, "tenant-a", resp.Claims[0].Summary["tenant"])
	// Trigger summary should carry type + workloadRef.
	assert.Equal(t, "webhook", resp.Triggers[0].Summary["type"])
	assert.Equal(t, "wl-1", resp.Triggers[0].Summary["workloadRef"])
	// Service summary should carry type.
	assert.Equal(t, "ClusterIP", resp.Services[0].Summary["type"])
	// Raw should be non-empty JSON for a spot-checked entry.
	assert.True(t, len(resp.Workloads[0].Raw) > 2)
}

// intFromInt32 is a tiny helper mirroring k8s intstr.FromInt32 without importing it.
func intFromInt32(i int32) intstrInt32 { return intstrInt32(i) }

type intstrInt32 int32

func (v intstrInt32) MarshalJSON() ([]byte, error) { return []byte(`1`), nil }
```

Note: if `intstr.FromInt32` is already available in this file via another import, prefer it. To avoid the helper complication, change the Service port definition to omit `TargetPort` (optional in envtest) — the handler does not need `TargetPort` to build its summary. The simpler form:

```go
require.NoError(t, srv.client.Create(ctx, &corev1.Service{
    ObjectMeta: metav1.ObjectMeta{Name: "svc-1", Namespace: ns, Labels: managedLabels},
    Spec: corev1.ServiceSpec{
        Type:  corev1.ServiceTypeClusterIP,
        Ports: []corev1.ServicePort{{Port: 80}},
    },
}))
```

**Use this simpler form and delete the `intFromInt32` / `intstrInt32` helpers** from the test.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd go && export KUBEBUILDER_ASSETS="$(setup-envtest use -p path)" && go test ./internal/api/ -run TestListDebugResources -v`

Expected: FAIL — assertion `assert.Len(t, resp.Workloads, 1)` fails because the skeleton handler returns an empty response.

- [ ] **Step 3: Commit**

```bash
git add go/internal/api/routes_debug_test.go
git commit -m "api: failing test for /debug/resources endpoint"
```

---

## Task 4: Backend — CRD listers

**Files:**
- Modify: `go/internal/api/routes_debug.go`

- [ ] **Step 1: Flesh out the handler for the four CRDs**

Replace the `listDebugResources` function in `go/internal/api/routes_debug.go` with:

```go
func (s *Server) listDebugResources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := client.InNamespace(s.namespace)

	var resp debugResourcesResponse

	var wls v1alpha1.BoilerhouseWorkloadList
	if err := s.client.List(ctx, &wls, ns); err != nil {
		writeError(w, http.StatusInternalServerError, "list workloads: "+err.Error())
		return
	}
	for i := range wls.Items {
		e, err := workloadToEntry(&wls.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal workload: "+err.Error())
			return
		}
		resp.Workloads = append(resp.Workloads, e)
	}

	var pools v1alpha1.BoilerhousePoolList
	if err := s.client.List(ctx, &pools, ns); err != nil {
		writeError(w, http.StatusInternalServerError, "list pools: "+err.Error())
		return
	}
	for i := range pools.Items {
		e, err := poolToEntry(&pools.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal pool: "+err.Error())
			return
		}
		resp.Pools = append(resp.Pools, e)
	}

	var claims v1alpha1.BoilerhouseClaimList
	if err := s.client.List(ctx, &claims, ns); err != nil {
		writeError(w, http.StatusInternalServerError, "list claims: "+err.Error())
		return
	}
	for i := range claims.Items {
		e, err := claimToEntry(&claims.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal claim: "+err.Error())
			return
		}
		resp.Claims = append(resp.Claims, e)
	}

	var triggers v1alpha1.BoilerhouseTriggerList
	if err := s.client.List(ctx, &triggers, ns); err != nil {
		writeError(w, http.StatusInternalServerError, "list triggers: "+err.Error())
		return
	}
	for i := range triggers.Items {
		e, err := triggerToEntry(&triggers.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal trigger: "+err.Error())
			return
		}
		resp.Triggers = append(resp.Triggers, e)
	}

	// Ensure non-nil slices so the JSON output always has 8 keys.
	if resp.Workloads == nil {
		resp.Workloads = []resourceEntry{}
	}
	if resp.Pools == nil {
		resp.Pools = []resourceEntry{}
	}
	if resp.Claims == nil {
		resp.Claims = []resourceEntry{}
	}
	if resp.Triggers == nil {
		resp.Triggers = []resourceEntry{}
	}
	resp.Pods = []resourceEntry{}
	resp.PersistentVolumeClaims = []resourceEntry{}
	resp.Services = []resourceEntry{}
	resp.NetworkPolicies = []resourceEntry{}

	writeJSON(w, http.StatusOK, resp)
}

func workloadToEntry(w *v1alpha1.BoilerhouseWorkload) (resourceEntry, error) {
	raw, err := json.Marshal(w)
	if err != nil {
		return resourceEntry{}, err
	}
	return resourceEntry{
		Name:  w.Name,
		Phase: w.Status.Phase,
		Age:   formatAge(w.CreationTimestamp),
		Summary: map[string]any{
			"image":   w.Spec.Image.Ref,
			"version": w.Spec.Version,
		},
		Raw: raw,
	}, nil
}

func poolToEntry(p *v1alpha1.BoilerhousePool) (resourceEntry, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return resourceEntry{}, err
	}
	return resourceEntry{
		Name:  p.Name,
		Phase: p.Status.Phase,
		Age:   formatAge(p.CreationTimestamp),
		Summary: map[string]any{
			"workloadRef": p.Spec.WorkloadRef,
			"desired":     p.Spec.Size,
			"ready":       p.Status.Ready,
		},
		Raw: raw,
	}, nil
}

func claimToEntry(c *v1alpha1.BoilerhouseClaim) (resourceEntry, error) {
	raw, err := json.Marshal(c)
	if err != nil {
		return resourceEntry{}, err
	}
	return resourceEntry{
		Name:  c.Name,
		Phase: c.Status.Phase,
		Age:   formatAge(c.CreationTimestamp),
		Summary: map[string]any{
			"tenant":      c.Spec.TenantId,
			"instance":    c.Status.InstanceId,
			"workloadRef": c.Spec.WorkloadRef,
		},
		Raw: raw,
	}, nil
}

func triggerToEntry(t *v1alpha1.BoilerhouseTrigger) (resourceEntry, error) {
	raw, err := json.Marshal(t)
	if err != nil {
		return resourceEntry{}, err
	}
	return resourceEntry{
		Name:  t.Name,
		Phase: t.Status.Phase,
		Age:   formatAge(t.CreationTimestamp),
		Summary: map[string]any{
			"type":        t.Spec.Type,
			"workloadRef": t.Spec.WorkloadRef,
		},
		Raw: raw,
	}, nil
}
```

Extend the import block at the top of `routes_debug.go` so it reads:

```go
import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)
```

**Note on field names:** this plan assumes `BoilerhousePool.Spec.Size`, `BoilerhousePool.Status.Ready`, `BoilerhouseClaim.Spec.TenantId`, `BoilerhouseClaim.Spec.WorkloadRef`, `BoilerhouseClaim.Status.InstanceId`, and Phase strings on each CRD's Status. Before writing code, run:

```bash
cd go && grep -n "^type.*Spec struct\|^type.*Status struct" api/v1alpha1/*.go
```

and open each file to confirm the exact field names. If any differ, substitute them in the code above and in Task 3's fixture construction. Do not invent fields that don't exist.

- [ ] **Step 2: Run the test; only CRD assertions should pass**

Run: `cd go && go test ./internal/api/ -run TestListDebugResources -v`

Expected: some assertions now pass (CRDs: Workloads=1, Pools=1, Claims=1, Triggers=1 and their summary fields); native-kind assertions still fail (all native slices empty).

- [ ] **Step 3: Commit**

```bash
git add go/internal/api/routes_debug.go
git commit -m "api: list Boilerhouse CRDs in /debug/resources"
```

---

## Task 5: Backend — native kind listers

**Files:**
- Modify: `go/internal/api/routes_debug.go`

- [ ] **Step 1: Add native-kind listing**

In `listDebugResources`, replace the four lines that zero out the native slices:

```go
	resp.Pods = []resourceEntry{}
	resp.PersistentVolumeClaims = []resourceEntry{}
	resp.Services = []resourceEntry{}
	resp.NetworkPolicies = []resourceEntry{}
```

with:

```go
	managed := client.MatchingLabels{"boilerhouse.dev/managed": "true"}

	var pods corev1.PodList
	if err := s.client.List(ctx, &pods, ns, managed); err != nil {
		writeError(w, http.StatusInternalServerError, "list pods: "+err.Error())
		return
	}
	resp.Pods = make([]resourceEntry, 0, len(pods.Items))
	for i := range pods.Items {
		e, err := podToEntry(&pods.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal pod: "+err.Error())
			return
		}
		resp.Pods = append(resp.Pods, e)
	}

	var pvcs corev1.PersistentVolumeClaimList
	if err := s.client.List(ctx, &pvcs, ns, managed); err != nil {
		writeError(w, http.StatusInternalServerError, "list pvcs: "+err.Error())
		return
	}
	resp.PersistentVolumeClaims = make([]resourceEntry, 0, len(pvcs.Items))
	for i := range pvcs.Items {
		e, err := pvcToEntry(&pvcs.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal pvc: "+err.Error())
			return
		}
		resp.PersistentVolumeClaims = append(resp.PersistentVolumeClaims, e)
	}

	var svcs corev1.ServiceList
	if err := s.client.List(ctx, &svcs, ns, managed); err != nil {
		writeError(w, http.StatusInternalServerError, "list services: "+err.Error())
		return
	}
	resp.Services = make([]resourceEntry, 0, len(svcs.Items))
	for i := range svcs.Items {
		e, err := serviceToEntry(&svcs.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal service: "+err.Error())
			return
		}
		resp.Services = append(resp.Services, e)
	}

	var nps networkingv1.NetworkPolicyList
	if err := s.client.List(ctx, &nps, ns, managed); err != nil {
		writeError(w, http.StatusInternalServerError, "list networkpolicies: "+err.Error())
		return
	}
	resp.NetworkPolicies = make([]resourceEntry, 0, len(nps.Items))
	for i := range nps.Items {
		e, err := networkPolicyToEntry(&nps.Items[i])
		if err != nil {
			writeError(w, http.StatusInternalServerError, "marshal networkpolicy: "+err.Error())
			return
		}
		resp.NetworkPolicies = append(resp.NetworkPolicies, e)
	}
```

Add the four new per-kind helpers at the bottom of the file:

```go
func podToEntry(p *corev1.Pod) (resourceEntry, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return resourceEntry{}, err
	}
	return resourceEntry{
		Name:  p.Name,
		Phase: string(p.Status.Phase),
		Age:   formatAge(p.CreationTimestamp),
		Summary: map[string]any{
			"node":   p.Spec.NodeName,
			"podIP":  p.Status.PodIP,
			"tenant": p.Labels["boilerhouse.dev/tenant"],
		},
		Raw: raw,
	}, nil
}

func pvcToEntry(p *corev1.PersistentVolumeClaim) (resourceEntry, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return resourceEntry{}, err
	}
	storageClass := ""
	if p.Spec.StorageClassName != nil {
		storageClass = *p.Spec.StorageClassName
	}
	capacity := ""
	if q, ok := p.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		capacity = q.String()
	}
	return resourceEntry{
		Name:  p.Name,
		Phase: string(p.Status.Phase),
		Age:   formatAge(p.CreationTimestamp),
		Summary: map[string]any{
			"storageClass": storageClass,
			"capacity":     capacity,
		},
		Raw: raw,
	}, nil
}

func serviceToEntry(s *corev1.Service) (resourceEntry, error) {
	raw, err := json.Marshal(s)
	if err != nil {
		return resourceEntry{}, err
	}
	ports := make([]string, 0, len(s.Spec.Ports))
	for _, p := range s.Spec.Ports {
		if p.Name != "" {
			ports = append(ports, fmt.Sprintf("%s:%d", p.Name, p.Port))
		} else {
			ports = append(ports, fmt.Sprintf("%d", p.Port))
		}
	}
	return resourceEntry{
		Name:  s.Name,
		Phase: "",
		Age:   formatAge(s.CreationTimestamp),
		Summary: map[string]any{
			"type":      string(s.Spec.Type),
			"clusterIP": s.Spec.ClusterIP,
			"ports":     strings.Join(ports, ","),
		},
		Raw: raw,
	}, nil
}

func networkPolicyToEntry(n *networkingv1.NetworkPolicy) (resourceEntry, error) {
	raw, err := json.Marshal(n)
	if err != nil {
		return resourceEntry{}, err
	}
	selector := "<all>"
	if m := n.Spec.PodSelector.MatchLabels; len(m) > 0 {
		parts := make([]string, 0, len(m))
		for k, v := range m {
			parts = append(parts, fmt.Sprintf("%s=%s", k, v))
		}
		selector = strings.Join(parts, ",")
	}
	return resourceEntry{
		Name:  n.Name,
		Phase: "",
		Age:   formatAge(n.CreationTimestamp),
		Summary: map[string]any{
			"podSelector": selector,
		},
		Raw: raw,
	}, nil
}
```

Extend the import block at the top of `routes_debug.go` so it reads:

```go
import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)
```

- [ ] **Step 2: Run the test — everything should pass**

Run: `cd go && go test ./internal/api/ -run TestListDebugResources -v`

Expected: PASS. All eight counts match, summary spot-checks pass, unmanaged pod excluded.

- [ ] **Step 3: Run the full api test suite**

Run: `cd go && go test ./internal/api/ -v`

Expected: all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add go/internal/api/routes_debug.go
git commit -m "api: list Pod/PVC/Service/NetworkPolicy in /debug/resources"
```

---

## Task 6: Frontend — API client types and fetcher

**Files:**
- Modify: `ts/apps/dashboard/src/api.ts`

- [ ] **Step 1: Add the types and fetcher**

In `ts/apps/dashboard/src/api.ts`, add this block above `// --- API methods ---`:

```ts
// Debug resources
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

Inside the `api` object (at the bottom of the file), add:

```ts
	// Debug resources
	fetchDebugResources: () => get<DebugResourcesResponse>("/debug/resources"),
```

- [ ] **Step 2: Type-check**

Run: `cd ts/apps/dashboard && bun x tsc --noEmit`

Expected: no errors. (If `tsc` isn't available that way, use `bunx tsc --noEmit` or the project's equivalent — check `package.json` scripts.)

- [ ] **Step 3: Commit**

```bash
git add ts/apps/dashboard/src/api.ts
git commit -m "dashboard: add fetchDebugResources API client"
```

---

## Task 7: Frontend — Kubernetes page component

**Files:**
- Create: `ts/apps/dashboard/src/pages/Kubernetes.tsx`

- [ ] **Step 1: Inspect `json-syntax.tsx` to confirm its exported API**

Run: `bunx head -n 30 ts/apps/dashboard/src/json-syntax.tsx` — or just open the file. You need the name of the exported component that pretty-prints a JSON value. In the code below it is assumed to be `JsonSyntax` taking a prop `value`. If the real export differs (e.g. `SyntaxHighlightedJson`, `JsonView`, prop `data` or `json`), substitute the correct identifiers.

- [ ] **Step 2: Create the page**

Create `ts/apps/dashboard/src/pages/Kubernetes.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DebugResourceEntry, type DebugResourcesResponse } from "../api";
import { useApi, useAutoRefresh } from "../hooks";
import { JsonSyntax } from "../json-syntax";

type KindKey =
	| "workloads"
	| "pools"
	| "claims"
	| "triggers"
	| "pods"
	| "persistentVolumeClaims"
	| "services"
	| "networkPolicies";

interface KindDef {
	key: KindKey;
	label: string;
	columns: { title: string; render: (e: DebugResourceEntry) => React.ReactNode }[];
}

function cell(value: unknown): string {
	if (value === null || value === undefined || value === "") return "-";
	return String(value);
}

const KINDS: KindDef[] = [
	{
		key: "workloads",
		label: "Workloads",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "image", render: (e) => cell(e.summary.image) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "pools",
		label: "Pools",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{
				title: "size",
				render: (e) => `${cell(e.summary.ready)}/${cell(e.summary.desired)}`,
			},
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "claims",
		label: "Claims",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "tenant", render: (e) => cell(e.summary.tenant) },
			{ title: "instance", render: (e) => cell(e.summary.instance) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "triggers",
		label: "Triggers",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "type", render: (e) => cell(e.summary.type) },
			{ title: "workload", render: (e) => cell(e.summary.workloadRef) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "pods",
		label: "Pods",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "node", render: (e) => cell(e.summary.node) },
			{ title: "podIP", render: (e) => cell(e.summary.podIP) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "persistentVolumeClaims",
		label: "PersistentVolumeClaims",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "storageClass", render: (e) => cell(e.summary.storageClass) },
			{ title: "capacity", render: (e) => cell(e.summary.capacity) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "services",
		label: "Services",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "type", render: (e) => cell(e.summary.type) },
			{ title: "clusterIP", render: (e) => cell(e.summary.clusterIP) },
			{ title: "ports", render: (e) => cell(e.summary.ports) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "networkPolicies",
		label: "NetworkPolicies",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "podSelector", render: (e) => cell(e.summary.podSelector) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
];

function Section({ def, entries }: { def: KindDef; entries: DebugResourceEntry[] }) {
	const [collapsed, setCollapsed] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	function toggleRow(name: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	return (
		<section className="mb-6">
			<button
				type="button"
				onClick={() => setCollapsed((c) => !c)}
				className="flex items-center gap-2 px-2 py-1 font-tight font-semibold text-white hover:bg-surface-3/50 rounded w-full text-left"
			>
				<span className="text-muted font-mono text-sm">{collapsed ? "▸" : "▾"}</span>
				<span>{def.label}</span>
				<span className="text-muted font-mono text-sm">({entries.length})</span>
			</button>
			{!collapsed && (
				<div className="mt-1 border border-border/20 rounded overflow-hidden">
					{entries.length === 0 ? (
						<div className="px-3 py-2 text-muted font-mono text-sm">no resources</div>
					) : (
						<table className="w-full text-sm font-mono">
							<thead className="bg-surface-2 text-muted-light">
								<tr>
									{def.columns.map((c) => (
										<th key={c.title} className="px-2 py-1 text-left font-normal">
											{c.title}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{entries.map((e) => {
									const isOpen = expanded.has(e.name);
									return (
										<>
											<tr
												key={e.name}
												onClick={() => toggleRow(e.name)}
												className="border-t border-border/10 cursor-pointer hover:bg-surface-2"
											>
												{def.columns.map((c) => (
													<td key={c.title} className="px-2 py-1">
														{c.render(e)}
													</td>
												))}
											</tr>
											{isOpen && (
												<tr key={`${e.name}-raw`} className="bg-surface-1">
													<td colSpan={def.columns.length} className="p-2">
														<JsonSyntax value={e.raw} />
													</td>
												</tr>
											)}
										</>
									);
								})}
							</tbody>
						</table>
					)}
				</div>
			)}
		</section>
	);
}

export function Kubernetes() {
	const { data, loading, error, refetch } = useApi<DebugResourcesResponse>(api.fetchDebugResources);
	const { setPaused } = useAutoRefresh(refetch, 3000);

	// Pause polling while the tab is hidden.
	useEffect(() => {
		const onVis = () => setPaused(document.visibilityState !== "visible");
		onVis();
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, [setPaused]);

	// Track "last refreshed N seconds ago" — update the display every second.
	const lastRefreshed = useRef<number>(Date.now());
	useEffect(() => {
		if (data) lastRefreshed.current = Date.now();
	}, [data]);

	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const secondsAgo = Math.max(0, Math.floor((now - lastRefreshed.current) / 1000));

	const sections = useMemo(() => {
		if (!data) return null;
		return KINDS.map((def) => (
			<Section key={def.key} def={def} entries={data[def.key]} />
		));
	}, [data]);

	return (
		<div>
			<div className="flex items-baseline justify-between mb-4">
				<h1 className="text-xl font-tight font-bold text-white">kubernetes</h1>
				<div className="flex items-center gap-3 text-sm font-mono text-muted">
					<span>{loading && !data ? "loading…" : `refreshed ${secondsAgo}s ago`}</span>
					<button
						type="button"
						onClick={() => refetch()}
						className="px-2 py-0.5 border border-border/30 rounded hover:bg-surface-2 text-muted-light"
					>
						refresh
					</button>
				</div>
			</div>

			{error && (
				<div className="mb-4 px-3 py-2 border border-status-red/30 bg-status-red/10 text-status-red font-mono text-sm rounded">
					{error}
				</div>
			)}

			{sections}
		</div>
	);
}
```

- [ ] **Step 3: Type-check**

Run: `cd ts/apps/dashboard && bunx tsc --noEmit`

Expected: no errors. If TS complains that `JsonSyntax` is not exported from `../json-syntax`, open that file and swap the import to the actual export name.

- [ ] **Step 4: Commit**

```bash
git add ts/apps/dashboard/src/pages/Kubernetes.tsx
git commit -m "dashboard: add kubernetes debug page"
```

---

## Task 8: Frontend — wire nav item and route

**Files:**
- Modify: `ts/apps/dashboard/src/app.tsx`

- [ ] **Step 1: Add import**

At the top of `ts/apps/dashboard/src/app.tsx`, change the lucide import to include `Boxes`:

```tsx
import { Boxes, Flame, Package, Zap } from "lucide-react";
```

And add the Kubernetes page import:

```tsx
import { Kubernetes } from "./pages/Kubernetes";
```

- [ ] **Step 2: Add nav item**

Extend the `NAV_ITEMS` array:

```tsx
const NAV_ITEMS: { path: string; label: string; icon: LucideIcon }[] = [
	{ path: "/workloads", label: "workloads", icon: Package },
	{ path: "/triggers", label: "triggers", icon: Zap },
	{ path: "/kubernetes", label: "kubernetes", icon: Boxes },
];
```

- [ ] **Step 3: Route the page**

In the `App` function's routing block, add an `else if` branch for `/kubernetes` before the final `else` (i.e. after the `/triggers` branch):

```tsx
		} else if (path === "/kubernetes") {
			content = <Kubernetes />;
```

- [ ] **Step 4: Type-check**

Run: `cd ts/apps/dashboard && bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ts/apps/dashboard/src/app.tsx
git commit -m "dashboard: add kubernetes nav item and route"
```

---

## Task 9: Manual smoke test

- [ ] **Step 1: Start the dev environment**

Run: `bunx kadai run dev`

Wait until operator + API are both up.

- [ ] **Step 2: Serve the dashboard**

In a second shell, run the dashboard dev command (check `ts/apps/dashboard/package.json` for the exact script — typically `bun run dev` from `ts/apps/dashboard/`).

- [ ] **Step 3: Open the dashboard and verify**

Navigate to `http://localhost:<dashboard-port>/#/kubernetes`.

Verify:
- All eight sections render (collapsed/expanded toggling works, default is expanded).
- "refreshed Ns ago" counter resets when data changes (create a Workload via kubectl or the API to see it appear within ~3s).
- Clicking a row expands the raw JSON with syntax highlighting.
- Switching tabs away and back pauses/resumes polling (watch network tab briefly).
- Unrelated Pods in the namespace (no `boilerhouse.dev/managed` label) do NOT appear in the Pods table.

- [ ] **Step 4: No commit**

Smoke test only — nothing to commit.

---

## Final verification

- [ ] **Step 1: Full test run**

Run: `bunx kadai run tests/unit`

Expected: all tests pass including `TestListDebugResources`.

- [ ] **Step 2: No lingering TODOs**

Run: `Grep` for `TODO` in the files you created. Expected: none.

- [ ] **Step 3: Done**

Plan complete.
