package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
