package api

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

func podToEntry(p *corev1.Pod) (resourceEntry, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return resourceEntry{}, err
	}
	phase := string(p.Status.Phase)
	if p.DeletionTimestamp != nil {
		phase = "Terminating"
	}
	return resourceEntry{
		Name:  p.Name,
		Phase: phase,
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
		proto := p.Protocol
		if proto == "" {
			proto = corev1.ProtocolTCP
		}
		if p.Name != "" {
			ports = append(ports, fmt.Sprintf("%s:%d/%s", p.Name, p.Port, proto))
		} else {
			ports = append(ports, fmt.Sprintf("%d/%s", p.Port, proto))
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
