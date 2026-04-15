package api

import (
	"net/http"

	corev1 "k8s.io/api/core/v1"
	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func (s *Server) getHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// statsResponse is the JSON representation of system statistics.
type statsResponse struct {
	Instances instanceStats `json:"instances"`
	Claims    claimStats    `json:"claims"`
}

type instanceStats struct {
	Total   int            `json:"total"`
	ByPhase map[string]int `json:"byPhase"`
}

type claimStats struct {
	Total   int            `json:"total"`
	ByPhase map[string]int `json:"byPhase"`
}

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Count managed pods by phase.
	var pods corev1.PodList
	if err := s.client.List(ctx, &pods,
		client.InNamespace(s.namespace),
		client.MatchingLabels{"boilerhouse.dev/managed": "true"},
	); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list pods: "+err.Error())
		return
	}

	podsByPhase := make(map[string]int)
	for i := range pods.Items {
		phase := string(pods.Items[i].Status.Phase)
		if phase == "" {
			phase = "Unknown"
		}
		podsByPhase[phase]++
	}

	// Count claims by phase.
	var claims v1alpha1.BoilerhouseClaimList
	if err := s.client.List(ctx, &claims, client.InNamespace(s.namespace)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list claims: "+err.Error())
		return
	}

	claimsByPhase := make(map[string]int)
	for i := range claims.Items {
		phase := claims.Items[i].Status.Phase
		if phase == "" {
			phase = "Pending"
		}
		claimsByPhase[phase]++
	}

	writeJSON(w, http.StatusOK, statsResponse{
		Instances: instanceStats{
			Total:   len(pods.Items),
			ByPhase: podsByPhase,
		},
		Claims: claimStats{
			Total:   len(claims.Items),
			ByPhase: claimsByPhase,
		},
	})
}
