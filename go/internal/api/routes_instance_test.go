package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Notes on scope:
//
// The exec and logs handlers shell out to `kubectl exec` / `kubectl logs`.
// envtest has no kubelet so those subprocesses can't succeed here; we cover
// only the input-validation and pod-existence paths for those handlers.
// Happy-path exec/logs are the job of the e2e-operator suite against
// minikube, not these unit tests.

func newManagedPod(name, tenant, workload string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: "default",
			Labels: map[string]string{
				"boilerhouse.dev/managed":  "true",
				"boilerhouse.dev/tenant":   tenant,
				"boilerhouse.dev/workload": workload,
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{
				Name:  "main",
				Image: "nginx:latest",
			}},
		},
	}
}

func TestListInstances_ReturnsOnlyManagedPods(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	managed := newManagedPod("tenant-pod-1", "alice", "wl-a")
	require.NoError(t, srv.client.Create(t.Context(), managed))

	unmanaged := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "bystander", Namespace: "default"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "c", Image: "nginx"}},
		},
	}
	require.NoError(t, srv.client.Create(t.Context(), unmanaged))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/instances", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var items []instanceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))
	require.Len(t, items, 1)
	assert.Equal(t, "tenant-pod-1", items[0].Name)
	assert.Equal(t, "alice", items[0].TenantId)
	assert.Equal(t, "wl-a", items[0].WorkloadRef)
}

func TestListInstances_EnrichesWithClaimData(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	pod := newManagedPod("claim-pod-1", "alice", "wl-a")
	require.NoError(t, srv.client.Create(t.Context(), pod))

	now := metav1.Now()
	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "claim-alice-wl-a",
			Namespace: "default",
			Annotations: map[string]string{
				"boilerhouse.dev/last-activity": "2026-04-21T00:00:00Z",
			},
		},
		Spec: v1alpha1.BoilerhouseClaimSpec{TenantId: "alice", WorkloadRef: "wl-a"},
	}
	require.NoError(t, srv.client.Create(t.Context(), claim))
	claim.Status.InstanceId = "claim-pod-1"
	claim.Status.ClaimedAt = &now
	require.NoError(t, srv.client.Status().Update(t.Context(), claim))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/instances", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var items []instanceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))
	require.Len(t, items, 1)
	assert.Equal(t, "2026-04-21T00:00:00Z", items[0].LastActivity)
	assert.NotEmpty(t, items[0].ClaimedAt)
}

func TestGetInstance_ReturnsDetails(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	pod := newManagedPod("detail-pod", "bob", "wl-b")
	require.NoError(t, srv.client.Create(t.Context(), pod))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/instances/detail-pod", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var got instanceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, "detail-pod", got.Name)
	assert.Equal(t, "bob", got.TenantId)
	assert.Equal(t, "wl-b", got.WorkloadRef)
}

func TestGetInstance_NotFound(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/instances/ghost", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestDestroyInstance_DeletesPod(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	pod := newManagedPod("doomed-pod", "carol", "wl-c")
	require.NoError(t, srv.client.Create(t.Context(), pod))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/doomed-pod/destroy", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "destroyed", resp["status"])
	assert.Equal(t, "doomed-pod", resp["instance"])

	var check corev1.Pod
	err := srv.client.Get(t.Context(), types.NamespacedName{Name: "doomed-pod", Namespace: "default"}, &check)
	// Envtest honours DeletionTimestamp — either the pod is gone (NotFound) or
	// it has a non-zero deletion timestamp. Either proves Delete() was called.
	if err == nil {
		assert.False(t, check.DeletionTimestamp.IsZero(), "pod should be marked for deletion")
	} else {
		assert.True(t, apierrors.IsNotFound(err))
	}
}

func TestDestroyInstance_NotFound(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/ghost/destroy", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestExecInInstance_RejectsInvalidJSON(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/any/exec", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid JSON")
}

func TestExecInInstance_RejectsEmptyCommand(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	body, _ := json.Marshal(execRequest{Command: nil})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/any/exec", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "command is required")
}

func TestGetInstanceLogs_NotFound(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/instances/ghost/logs", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}
