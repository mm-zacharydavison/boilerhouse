package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// workloadRequest is the JSON body for creating/updating a workload.
type workloadRequest struct {
	Name string                         `json:"name"`
	Spec v1alpha1.BoilerhouseWorkloadSpec `json:"spec"`
}

// workloadResponse is the JSON representation of a workload returned by the API.
type workloadResponse struct {
	Name      string                            `json:"name"`
	Spec      v1alpha1.BoilerhouseWorkloadSpec   `json:"spec"`
	Status    v1alpha1.BoilerhouseWorkloadStatus `json:"status"`
	CreatedAt string                            `json:"createdAt"`
}

func toWorkloadResponse(wl *v1alpha1.BoilerhouseWorkload) workloadResponse {
	return workloadResponse{
		Name:      wl.Name,
		Spec:      wl.Spec,
		Status:    wl.Status,
		CreatedAt: wl.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z"),
	}
}

func (s *Server) createWorkload(w http.ResponseWriter, r *http.Request) {
	var req workloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: s.namespace,
		},
		Spec: req.Spec,
	}

	if err := s.client.Create(r.Context(), wl); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create workload: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, toWorkloadResponse(wl))
}

func (s *Server) listWorkloads(w http.ResponseWriter, r *http.Request) {
	var list v1alpha1.BoilerhouseWorkloadList
	if err := s.client.List(r.Context(), &list, client.InNamespace(s.namespace)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list workloads: "+err.Error())
		return
	}

	items := make([]workloadResponse, 0, len(list.Items))
	for i := range list.Items {
		items = append(items, toWorkloadResponse(&list.Items[i]))
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) getWorkload(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	var wl v1alpha1.BoilerhouseWorkload
	key := types.NamespacedName{Name: name, Namespace: s.namespace}
	if err := s.client.Get(r.Context(), key, &wl); err != nil {
		writeError(w, http.StatusNotFound, "workload not found: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, toWorkloadResponse(&wl))
}

func (s *Server) updateWorkload(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	var req workloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	var wl v1alpha1.BoilerhouseWorkload
	key := types.NamespacedName{Name: name, Namespace: s.namespace}
	if err := s.client.Get(r.Context(), key, &wl); err != nil {
		writeError(w, http.StatusNotFound, "workload not found: "+err.Error())
		return
	}

	wl.Spec = req.Spec
	if err := s.client.Update(r.Context(), &wl); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update workload: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, toWorkloadResponse(&wl))
}

func (s *Server) deleteWorkload(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.namespace,
		},
	}

	if err := s.client.Delete(r.Context(), wl); err != nil {
		writeError(w, http.StatusNotFound, "workload not found: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
