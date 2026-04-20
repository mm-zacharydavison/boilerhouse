package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
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
