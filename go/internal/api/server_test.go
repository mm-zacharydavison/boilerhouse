package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

// envtestResult holds the output of setupEnvtest.
type envtestResult struct {
	ctx        context.Context
	client     client.Client
	restConfig *rest.Config
	cleanup    func()
}

// setupEnvtest starts an envtest environment with the Boilerhouse CRDs loaded.
func setupEnvtest(t *testing.T) envtestResult {
	t.Helper()

	_, thisFile, _, _ := runtime.Caller(0)
	crdPath := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "config", "crd", "bases-go")

	env := &envtest.Environment{
		CRDDirectoryPaths: []string{crdPath},
	}

	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("failed to start envtest: %v", err)
	}

	s := k8sruntime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		env.Stop()
		t.Fatalf("failed to add client-go scheme: %v", err)
	}
	if err := v1alpha1.AddToScheme(s); err != nil {
		env.Stop()
		t.Fatalf("failed to add v1alpha1 scheme: %v", err)
	}

	k8sClient, err := client.New(cfg, client.Options{Scheme: s})
	if err != nil {
		env.Stop()
		t.Fatalf("failed to create client: %v", err)
	}

	ctx := context.Background()
	cleanup := func() {
		if err := env.Stop(); err != nil {
			t.Logf("warning: failed to stop envtest: %v", err)
		}
	}

	return envtestResult{ctx: ctx, client: k8sClient, restConfig: cfg, cleanup: cleanup}
}

// newTestServer creates a Server backed by envtest for integration testing.
// It creates the "default" namespace and returns the server plus cleanup func.
func newTestServer(t *testing.T) (*Server, func()) {
	t.Helper()

	env := setupEnvtest(t)

	// envtest comes with a "default" namespace, so we use that.
	srv := &Server{
		client:     env.client,
		restConfig: env.restConfig,
		namespace:  "default",
		apiKey:     "",
	}
	srv.router = srv.buildRouter()

	return srv, env.cleanup
}

func TestHealthEndpoint(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)

	var body map[string]string
	err := json.Unmarshal(rec.Body.Bytes(), &body)
	require.NoError(t, err)
	assert.Equal(t, "ok", body["status"])
}

func TestAuthMiddleware_RejectsWithoutKey(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	// Set an API key to enable auth enforcement.
	srv.apiKey = "test-secret-key"

	// Request without Authorization header should be rejected.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	var body map[string]string
	err := json.Unmarshal(rec.Body.Bytes(), &body)
	require.NoError(t, err)
	assert.Contains(t, body["error"], "Authorization")
}

func TestAuthMiddleware_AcceptsValidKey(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	srv.apiKey = "test-secret-key"

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	req.Header.Set("Authorization", "Bearer test-secret-key")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	// Should pass auth and return 200 (empty list).
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestCreateAndGetWorkload(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	// Create a workload.
	payload := workloadRequest{
		Name: "test-wl",
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1.0.0",
			Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 512,
				DiskGb:   10,
			},
		},
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workloads", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)

	var created workloadResponse
	err := json.Unmarshal(rec.Body.Bytes(), &created)
	require.NoError(t, err)
	assert.Equal(t, "test-wl", created.Name)
	assert.Equal(t, "1.0.0", created.Spec.Version)
	assert.Equal(t, "nginx:latest", created.Spec.Image.Ref)

	// Get the workload back.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/workloads/test-wl", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var fetched workloadResponse
	err = json.Unmarshal(rec.Body.Bytes(), &fetched)
	require.NoError(t, err)
	assert.Equal(t, "test-wl", fetched.Name)
	assert.Equal(t, "1.0.0", fetched.Spec.Version)
}

func TestListWorkloads(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	// Create two workloads.
	for _, name := range []string{"wl-one", "wl-two"} {
		payload := workloadRequest{
			Name: name,
			Spec: v1alpha1.BoilerhouseWorkloadSpec{
				Version: "1.0.0",
				Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
				Resources: v1alpha1.WorkloadResources{
					VCPUs:    1,
					MemoryMb: 256,
					DiskGb:   5,
				},
			},
		}
		body, _ := json.Marshal(payload)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/workloads", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code, "failed to create workload %s", name)
	}

	// List workloads.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var items []workloadResponse
	err := json.Unmarshal(rec.Body.Bytes(), &items)
	require.NoError(t, err)
	assert.Len(t, items, 2)
}

func TestUpdateWorkload(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	// Create a workload.
	payload := workloadRequest{
		Name: "update-me",
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1.0.0",
			Image:   v1alpha1.WorkloadImage{Ref: "nginx:1.0"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 256,
				DiskGb:   5,
			},
		},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workloads", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)

	// Update the workload.
	payload.Spec.Version = "2.0.0"
	payload.Spec.Image.Ref = "nginx:2.0"
	body, _ = json.Marshal(payload)
	req = httptest.NewRequest(http.MethodPut, "/api/v1/workloads/update-me", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var updated workloadResponse
	err := json.Unmarshal(rec.Body.Bytes(), &updated)
	require.NoError(t, err)
	assert.Equal(t, "2.0.0", updated.Spec.Version)
	assert.Equal(t, "nginx:2.0", updated.Spec.Image.Ref)
}

func TestDeleteWorkload(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	// Create then delete.
	payload := workloadRequest{
		Name: "delete-me",
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1.0.0",
			Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 256,
				DiskGb:   5,
			},
		},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workloads", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/workloads/delete-me", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	// Verify it's gone.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/workloads/delete-me", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestSecurityHeaders(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, "DENY", rec.Header().Get("X-Frame-Options"))
}

func TestStatsEndpoint(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/stats", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var stats statsResponse
	err := json.Unmarshal(rec.Body.Bytes(), &stats)
	require.NoError(t, err)
	assert.Equal(t, 0, stats.Instances.Total)
	assert.Equal(t, 0, stats.Claims.Total)
}

func TestSecretRoutes(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	tenantID := "tenant-abc"

	// Set a secret.
	body, _ := json.Marshal(secretSetRequest{Value: "s3cret"})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/tenants/"+tenantID+"/secrets/db-password", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)

	// List secrets.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/tenants/"+tenantID+"/secrets", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var keys []string
	err := json.Unmarshal(rec.Body.Bytes(), &keys)
	require.NoError(t, err)
	assert.Contains(t, keys, "db-password")

	// Delete the secret key.
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/tenants/"+tenantID+"/secrets/db-password", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	// List again — should be empty.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/tenants/"+tenantID+"/secrets", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var emptyKeys []string
	err = json.Unmarshal(rec.Body.Bytes(), &emptyKeys)
	require.NoError(t, err)
	assert.Empty(t, emptyKeys)
}

func TestTriggerRoutes(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	// Create a trigger.
	payload := triggerRequest{
		Name: "my-trigger",
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "webhook",
			WorkloadRef: "some-workload",
		},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/triggers", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)

	// Get the trigger.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/triggers/my-trigger", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var fetched triggerResponse
	err := json.Unmarshal(rec.Body.Bytes(), &fetched)
	require.NoError(t, err)
	assert.Equal(t, "my-trigger", fetched.Name)
	assert.Equal(t, "webhook", fetched.Spec.Type)

	// List triggers.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/triggers", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var items []triggerResponse
	err = json.Unmarshal(rec.Body.Bytes(), &items)
	require.NoError(t, err)
	assert.Len(t, items, 1)

	// Delete the trigger.
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/triggers/my-trigger", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	// Verify it's gone.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/triggers/my-trigger", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

// Suppress unused import warnings — corev1 is used for Pod type in other tests.
var _ = corev1.Pod{}
