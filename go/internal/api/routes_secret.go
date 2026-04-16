package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// secretSetRequest is the JSON body for setting a secret value.
type secretSetRequest struct {
	Value string `json:"value"`
}

// secretName returns the K8s Secret name for a tenant.
func secretName(tenantID string) string {
	return fmt.Sprintf("bh-secret-%s", tenantID)
}

func (s *Server) setSecret(w http.ResponseWriter, r *http.Request) {
	tenantID := chi.URLParam(r, "id")
	name := chi.URLParam(r, "name")

	var req secretSetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	sName := secretName(tenantID)
	key := types.NamespacedName{Name: sName, Namespace: s.namespace}

	var secret corev1.Secret
	err := s.client.Get(r.Context(), key, &secret)
	if apierrors.IsNotFound(err) {
		// Create a new Secret for this tenant.
		secret = corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name:      sName,
				Namespace: s.namespace,
				Labels: map[string]string{
					"boilerhouse.dev/tenant": tenantID,
				},
			},
			Data: map[string][]byte{
				name: []byte(req.Value),
			},
		}
		if err := s.client.Create(r.Context(), &secret); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create secret: "+err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"status": "created", "key": name})
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get secret: "+err.Error())
		return
	}

	// Update the existing secret.
	if secret.Data == nil {
		secret.Data = make(map[string][]byte)
	}
	secret.Data[name] = []byte(req.Value)
	if err := s.client.Update(r.Context(), &secret); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update secret: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "key": name})
}

func (s *Server) listSecrets(w http.ResponseWriter, r *http.Request) {
	tenantID := chi.URLParam(r, "id")
	sName := secretName(tenantID)
	key := types.NamespacedName{Name: sName, Namespace: s.namespace}

	var secret corev1.Secret
	if err := s.client.Get(r.Context(), key, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			writeJSON(w, http.StatusOK, []string{})
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get secret: "+err.Error())
		return
	}

	keys := make([]string, 0, len(secret.Data))
	for k := range secret.Data {
		keys = append(keys, k)
	}

	writeJSON(w, http.StatusOK, keys)
}

func (s *Server) deleteSecret(w http.ResponseWriter, r *http.Request) {
	tenantID := chi.URLParam(r, "id")
	name := chi.URLParam(r, "name")
	sName := secretName(tenantID)
	key := types.NamespacedName{Name: sName, Namespace: s.namespace}

	var secret corev1.Secret
	if err := s.client.Get(r.Context(), key, &secret); err != nil {
		writeError(w, http.StatusNotFound, "secret not found: "+err.Error())
		return
	}

	if _, exists := secret.Data[name]; !exists {
		writeError(w, http.StatusNotFound, "key not found in secret")
		return
	}

	delete(secret.Data, name)

	// If the secret has no more keys, delete the entire Secret resource.
	if len(secret.Data) == 0 {
		if err := s.client.Delete(r.Context(), &secret); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to delete secret: "+err.Error())
			return
		}
	} else {
		if err := s.client.Update(r.Context(), &secret); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update secret: "+err.Error())
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "key": name})
}
