package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// claimRequest is the JSON body for claiming an instance.
type claimRequest struct {
	Workload    string `json:"workload"`
	WorkloadRef string `json:"workloadRef"`
	Resume      *bool  `json:"resume,omitempty"`
}

func (c *claimRequest) workloadName() string {
	if c.Workload != "" {
		return c.Workload
	}
	return c.WorkloadRef
}

// claimResponse is the JSON representation of a claim returned by the API.
type claimResponse struct {
	TenantId   string                          `json:"tenantId"`
	Phase      string                          `json:"phase"`
	InstanceId string                          `json:"instanceId,omitempty"`
	Endpoint   *v1alpha1.ClaimEndpoint         `json:"endpoint,omitempty"`
	Source     string                          `json:"source,omitempty"`
	ClaimedAt  string                          `json:"claimedAt,omitempty"`
	Detail     string                          `json:"detail,omitempty"`
}

func toClaimResponse(c *v1alpha1.BoilerhouseClaim) claimResponse {
	resp := claimResponse{
		TenantId:   c.Spec.TenantId,
		Phase:      c.Status.Phase,
		InstanceId: c.Status.InstanceId,
		Endpoint:   c.Status.Endpoint,
		Source:     c.Status.Source,
		Detail:     c.Status.Detail,
	}
	if c.Status.ClaimedAt != nil {
		resp.ClaimedAt = c.Status.ClaimedAt.UTC().Format("2006-01-02T15:04:05Z")
	}
	return resp
}

// tenantResponse is the JSON representation of a tenant (derived from claims).
type tenantResponse struct {
	TenantId string          `json:"tenantId"`
	Claims   []claimResponse `json:"claims"`
}

func (s *Server) claimInstance(w http.ResponseWriter, r *http.Request) {
	tenantID := chi.URLParam(r, "id")

	var req claimRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	wlName := req.workloadName()
	if wlName == "" {
		writeError(w, http.StatusBadRequest, "workload is required")
		return
	}

	claim, outcome, err := s.acquireClaim(r.Context(), tenantID, wlName, req.Resume)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if outcome == outcomeExistingActive {
		writeJSON(w, http.StatusOK, toClaimResponse(claim))
		return
	}

	// Poll the freshly-created claim until it reaches a terminal phase.
	result, err := s.pollClaim(r.Context(), claim.Name, 30*time.Second, 500*time.Millisecond)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed polling claim: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, toClaimResponse(result))
}

func (s *Server) releaseInstance(w http.ResponseWriter, r *http.Request) {
	tenantID := chi.URLParam(r, "id")

	var req claimRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	wlName := req.workloadName()
	if wlName == "" {
		writeError(w, http.StatusBadRequest, "workload is required")
		return
	}

	claimName := fmt.Sprintf("claim-%s-%s", tenantID, wlName)

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      claimName,
			Namespace: s.namespace,
		},
	}

	if err := s.client.Delete(r.Context(), claim); err != nil {
		writeError(w, http.StatusNotFound, "claim not found: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "released", "tenantId": tenantID})
}

func (s *Server) getTenant(w http.ResponseWriter, r *http.Request) {
	tenantID := chi.URLParam(r, "id")

	var list v1alpha1.BoilerhouseClaimList
	if err := s.client.List(r.Context(), &list,
		client.InNamespace(s.namespace),
		client.MatchingLabels{"boilerhouse.dev/tenant": tenantID},
	); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list claims: "+err.Error())
		return
	}

	if len(list.Items) == 0 {
		writeError(w, http.StatusNotFound, "tenant not found")
		return
	}

	claims := make([]claimResponse, 0, len(list.Items))
	for i := range list.Items {
		claims = append(claims, toClaimResponse(&list.Items[i]))
	}

	writeJSON(w, http.StatusOK, tenantResponse{
		TenantId: tenantID,
		Claims:   claims,
	})
}

func (s *Server) listTenants(w http.ResponseWriter, r *http.Request) {
	var list v1alpha1.BoilerhouseClaimList
	if err := s.client.List(r.Context(), &list, client.InNamespace(s.namespace)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list claims: "+err.Error())
		return
	}

	// Group claims by tenant.
	byTenant := make(map[string][]claimResponse)
	for i := range list.Items {
		tid := list.Items[i].Spec.TenantId
		byTenant[tid] = append(byTenant[tid], toClaimResponse(&list.Items[i]))
	}

	tenants := make([]tenantResponse, 0, len(byTenant))
	for tid, claims := range byTenant {
		tenants = append(tenants, tenantResponse{
			TenantId: tid,
			Claims:   claims,
		})
	}

	writeJSON(w, http.StatusOK, tenants)
}
