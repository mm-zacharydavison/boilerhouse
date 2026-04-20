package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
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

// triggerOwnsTenant returns true when the trigger's effective tenant matches
// the scoped caller's tenant. Admins bypass this check at the call site.
func triggerOwnsScope(t *v1alpha1.BoilerhouseTrigger, tenant, workload string) bool {
	if t.Spec.WorkloadRef != workload {
		return false
	}
	if t.Spec.Tenant == nil || t.Spec.Tenant.Static != tenant || t.Spec.Tenant.From != "" {
		return false
	}
	return true
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

	// Scoped callers (pod tokens) are restricted to cron triggers firing
	// against their own tenant + workload. Admins have no such restriction.
	ac, _ := AuthFromContext(r.Context())
	if ac.Kind == AuthScoped {
		if req.Spec.Type != "cron" {
			writeError(w, http.StatusForbidden, "scoped tokens may only create cron triggers")
			return
		}
		if req.Spec.WorkloadRef != ac.Workload {
			writeError(w, http.StatusForbidden, "trigger workloadRef must match the token's workload")
			return
		}
		if req.Spec.Tenant == nil || req.Spec.Tenant.Static != ac.TenantID || req.Spec.Tenant.From != "" {
			writeError(w, http.StatusForbidden, "trigger tenant.static must match the token's tenant and tenant.from must be empty")
			return
		}
	}

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: s.namespace,
		},
		Spec: req.Spec,
	}

	// Stamp ownership labels on every trigger so listTriggers can filter
	// cheaply and so admin-created triggers also expose a tenant label.
	if trigger.Spec.Tenant != nil && trigger.Spec.Tenant.Static != "" {
		if trigger.Labels == nil {
			trigger.Labels = map[string]string{}
		}
		trigger.Labels[claimtoken.LabelTenant] = trigger.Spec.Tenant.Static
	}
	if trigger.Spec.WorkloadRef != "" {
		if trigger.Labels == nil {
			trigger.Labels = map[string]string{}
		}
		trigger.Labels[claimtoken.LabelWorkload] = trigger.Spec.WorkloadRef
	}

	if err := s.client.Create(r.Context(), trigger); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create trigger: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, toTriggerResponse(trigger))
}

func (s *Server) listTriggers(w http.ResponseWriter, r *http.Request) {
	opts := []client.ListOption{client.InNamespace(s.namespace)}

	// Scoped callers only see triggers owned by their tenant+workload.
	ac, _ := AuthFromContext(r.Context())
	if ac.Kind == AuthScoped {
		opts = append(opts, client.MatchingLabels{
			claimtoken.LabelTenant:   ac.TenantID,
			claimtoken.LabelWorkload: ac.Workload,
		})
	}

	var list v1alpha1.BoilerhouseTriggerList
	if err := s.client.List(r.Context(), &list, opts...); err != nil {
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

	// Scoped callers: 404 (not 403) if the trigger isn't theirs — avoid
	// leaking existence of other tenants' resources.
	ac, _ := AuthFromContext(r.Context())
	if ac.Kind == AuthScoped && !triggerOwnsScope(&trigger, ac.TenantID, ac.Workload) {
		writeError(w, http.StatusNotFound, "trigger not found")
		return
	}

	writeJSON(w, http.StatusOK, toTriggerResponse(&trigger))
}

func (s *Server) deleteTrigger(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Scoped callers must own the trigger — load it first to check, then
	// delete. 404 on miss, same as getTrigger.
	ac, _ := AuthFromContext(r.Context())
	if ac.Kind == AuthScoped {
		var existing v1alpha1.BoilerhouseTrigger
		key := types.NamespacedName{Name: id, Namespace: s.namespace}
		if err := s.client.Get(r.Context(), key, &existing); err != nil {
			writeError(w, http.StatusNotFound, "trigger not found: "+err.Error())
			return
		}
		if !triggerOwnsScope(&existing, ac.TenantID, ac.Workload) {
			writeError(w, http.StatusNotFound, "trigger not found")
			return
		}
	}

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
