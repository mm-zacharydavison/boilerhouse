package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
)

// resourceEntry is the JSON shape for a single object in the debug/resources
// response. Phase is empty for kinds that don't have one. Summary holds a
// small per-kind set of fields used by the dashboard to populate row columns.
// Raw is the full K8s object marshaled back to JSON.
type resourceEntry struct {
	Name    string          `json:"name"`
	Phase   string          `json:"phase"`
	Age     string          `json:"age"`
	Summary map[string]any  `json:"summary"`
	Raw     json.RawMessage `json:"raw"`
}

// kindGroup is one row-group in the debug/resources response — a single
// Kubernetes resource type and its instances in the namespace.
type kindGroup struct {
	Kind       string          `json:"kind"`
	APIVersion string          `json:"apiVersion"`
	Resources  []resourceEntry `json:"resources"`
}

// debugResourcesResponse is the JSON shape returned by GET /debug/resources.
type debugResourcesResponse struct {
	Groups []kindGroup `json:"groups"`
}

// kindOrder controls the display order of groups. Kinds listed here are
// rendered first, in the given order; unlisted kinds come after, alphabetical.
var kindOrder = []string{
	"BoilerhouseWorkload",
	"BoilerhousePool",
	"BoilerhouseClaim",
	"BoilerhouseTrigger",
	"Pod",
	"Deployment",
	"ReplicaSet",
	"Service",
	"Endpoints",
	"PersistentVolumeClaim",
	"NetworkPolicy",
	"ConfigMap",
	"Secret",
	"ServiceAccount",
	"Event",
}

func (s *Server) listDebugResources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	if s.restConfig == nil {
		writeError(w, http.StatusInternalServerError, "rest config unavailable")
		return
	}

	disco, err := discovery.NewDiscoveryClientForConfig(s.restConfig)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "discovery client: "+err.Error())
		return
	}
	dyn, err := dynamic.NewForConfig(s.restConfig)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "dynamic client: "+err.Error())
		return
	}

	// Discovery returns the preferred API version per group. Partial-result
	// errors are normal (e.g. metrics.k8s.io may be unreachable); accept the
	// partial list.
	apiLists, _ := disco.ServerPreferredNamespacedResources()

	var groups []kindGroup
	for _, apiList := range apiLists {
		gv, err := schema.ParseGroupVersion(apiList.GroupVersion)
		if err != nil {
			continue
		}
		for _, res := range apiList.APIResources {
			if strings.Contains(res.Name, "/") {
				continue // subresource
			}
			if !hasVerb(res.Verbs, "list") {
				continue
			}
			gvr := schema.GroupVersionResource{
				Group:    gv.Group,
				Version:  gv.Version,
				Resource: res.Name,
			}
			ul, err := dyn.Resource(gvr).Namespace(s.namespace).List(ctx, metav1.ListOptions{})
			if err != nil {
				continue // skip kinds we can't list (RBAC, missing, etc.)
			}
			if len(ul.Items) == 0 {
				continue // hide empty groups to reduce noise
			}
			group := kindGroup{
				Kind:       res.Kind,
				APIVersion: apiList.GroupVersion,
				Resources:  make([]resourceEntry, 0, len(ul.Items)),
			}
			for i := range ul.Items {
				entry, err := unstructuredToEntry(&ul.Items[i], res.Kind)
				if err != nil {
					continue
				}
				group.Resources = append(group.Resources, entry)
			}
			if len(group.Resources) > 0 {
				groups = append(groups, group)
			}
		}
	}

	sortGroups(groups)

	if groups == nil {
		groups = []kindGroup{}
	}
	writeJSON(w, http.StatusOK, debugResourcesResponse{Groups: groups})
}

func hasVerb(verbs metav1.Verbs, v string) bool {
	for _, x := range verbs {
		if x == v {
			return true
		}
	}
	return false
}

func sortGroups(groups []kindGroup) {
	priority := make(map[string]int, len(kindOrder))
	for i, k := range kindOrder {
		priority[k] = i
	}
	sort.SliceStable(groups, func(i, j int) bool {
		pi, pok := priority[groups[i].Kind]
		pj, pjok := priority[groups[j].Kind]
		if pok && pjok {
			return pi < pj
		}
		if pok {
			return true
		}
		if pjok {
			return false
		}
		return groups[i].Kind < groups[j].Kind
	})
}

// unstructuredToEntry dispatches to a typed helper for known kinds, or falls
// back to a generic entry otherwise. Secrets are special-cased to redact
// data values.
func unstructuredToEntry(u *unstructured.Unstructured, kind string) (resourceEntry, error) {
	switch kind {
	case "BoilerhouseWorkload":
		var w v1alpha1.BoilerhouseWorkload
		if err := fromUnstructured(u, &w); err != nil {
			return genericEntry(u), nil
		}
		return workloadToEntry(&w)
	case "BoilerhousePool":
		var p v1alpha1.BoilerhousePool
		if err := fromUnstructured(u, &p); err != nil {
			return genericEntry(u), nil
		}
		return poolToEntry(&p)
	case "BoilerhouseClaim":
		var c v1alpha1.BoilerhouseClaim
		if err := fromUnstructured(u, &c); err != nil {
			return genericEntry(u), nil
		}
		return claimToEntry(&c)
	case "BoilerhouseTrigger":
		var t v1alpha1.BoilerhouseTrigger
		if err := fromUnstructured(u, &t); err != nil {
			return genericEntry(u), nil
		}
		return triggerToEntry(&t)
	case "Pod":
		var p corev1.Pod
		if err := fromUnstructured(u, &p); err != nil {
			return genericEntry(u), nil
		}
		return podToEntry(&p)
	case "PersistentVolumeClaim":
		var p corev1.PersistentVolumeClaim
		if err := fromUnstructured(u, &p); err != nil {
			return genericEntry(u), nil
		}
		return pvcToEntry(&p)
	case "Service":
		var svc corev1.Service
		if err := fromUnstructured(u, &svc); err != nil {
			return genericEntry(u), nil
		}
		return serviceToEntry(&svc)
	case "NetworkPolicy":
		var np networkingv1.NetworkPolicy
		if err := fromUnstructured(u, &np); err != nil {
			return genericEntry(u), nil
		}
		return networkPolicyToEntry(&np)
	case "Secret":
		return secretToEntry(u)
	default:
		return genericEntry(u), nil
	}
}

func fromUnstructured(u *unstructured.Unstructured, out any) error {
	return runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, out)
}

// genericEntry is the fallback for kinds without a typed helper. It exposes
// name, age, and raw JSON — no summary columns.
func genericEntry(u *unstructured.Unstructured) resourceEntry {
	raw, _ := json.Marshal(u)
	return resourceEntry{
		Name:    u.GetName(),
		Age:     formatAge(u.GetCreationTimestamp()),
		Summary: map[string]any{},
		Raw:     raw,
	}
}

// secretToEntry redacts data and stringData values before marshaling, so
// the dashboard can show which keys exist without exposing the values.
// The endpoint is behind API-key auth, but value redaction still reduces
// the blast radius of an accidental console-log or screenshot.
func secretToEntry(u *unstructured.Unstructured) (resourceEntry, error) {
	copy := u.DeepCopy()
	keys := redactSecretValues(copy)
	raw, err := json.Marshal(copy)
	if err != nil {
		return resourceEntry{}, err
	}
	secretType, _, _ := unstructured.NestedString(copy.Object, "type")
	return resourceEntry{
		Name:    u.GetName(),
		Age:     formatAge(u.GetCreationTimestamp()),
		Summary: map[string]any{"type": secretType, "keys": strings.Join(keys, ",")},
		Raw:     raw,
	}, nil
}

func redactSecretValues(u *unstructured.Unstructured) []string {
	keySet := map[string]struct{}{}
	for _, field := range []string{"data", "stringData"} {
		m, ok := u.Object[field].(map[string]any)
		if !ok {
			continue
		}
		redacted := make(map[string]any, len(m))
		for k := range m {
			redacted[k] = "<redacted>"
			keySet[k] = struct{}{}
		}
		u.Object[field] = redacted
	}
	keys := make([]string, 0, len(keySet))
	for k := range keySet {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
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
