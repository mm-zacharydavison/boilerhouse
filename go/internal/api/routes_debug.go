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
