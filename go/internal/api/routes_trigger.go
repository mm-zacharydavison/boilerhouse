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

// triggerRequest is the JSON body for creating a trigger.
type triggerRequest struct {
	Name string                          `json:"name"`
	Spec v1alpha1.BoilerhouseTriggerSpec `json:"spec"`
}

// triggerResponse is the JSON representation of a trigger.
type triggerResponse struct {
	Name      string                            `json:"name"`
	Spec      v1alpha1.BoilerhouseTriggerSpec   `json:"spec"`
	Status    v1alpha1.BoilerhouseTriggerStatus `json:"status"`
	CreatedAt string                            `json:"createdAt"`
}

func toTriggerResponse(t *v1alpha1.BoilerhouseTrigger) triggerResponse {
	return triggerResponse{
		Name:      t.Name,
		Spec:      t.Spec,
		Status:    t.Status,
		CreatedAt: t.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z"),
	}
}

func (s *Server) createTrigger(w http.ResponseWriter, r *http.Request) {
	var req triggerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: s.namespace,
		},
		Spec: req.Spec,
	}

	if err := s.client.Create(r.Context(), trigger); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create trigger: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, toTriggerResponse(trigger))
}

func (s *Server) listTriggers(w http.ResponseWriter, r *http.Request) {
	var list v1alpha1.BoilerhouseTriggerList
	if err := s.client.List(r.Context(), &list, client.InNamespace(s.namespace)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list triggers: "+err.Error())
		return
	}

	items := make([]triggerResponse, 0, len(list.Items))
	for i := range list.Items {
		items = append(items, toTriggerResponse(&list.Items[i]))
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) getTrigger(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var trigger v1alpha1.BoilerhouseTrigger
	key := types.NamespacedName{Name: id, Namespace: s.namespace}
	if err := s.client.Get(r.Context(), key, &trigger); err != nil {
		writeError(w, http.StatusNotFound, "trigger not found: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, toTriggerResponse(&trigger))
}

func (s *Server) deleteTrigger(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{
			Name:      id,
			Namespace: s.namespace,
		},
	}

	if err := s.client.Delete(r.Context(), trigger); err != nil {
		writeError(w, http.StatusNotFound, "trigger not found: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
