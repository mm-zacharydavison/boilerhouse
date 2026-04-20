package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	"github.com/zdavison/boilerhouse/go/internal/scope"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// newAuthTestServer returns a Server wired to a fully-started TokenStore plus
// the envtest client (so tests can create Secrets at will) and a cleanup.
func newAuthTestServer(t *testing.T) (*Server, *TokenStore, envtestResult) {
	t.Helper()
	env := setupEnvtest(t)
	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(env.ctx)
	t.Cleanup(cancel)
	require.NoError(t, ts.Start(ctx))

	srv := &Server{
		client:     env.client,
		restConfig: env.restConfig,
		namespace:  "default",
		apiKey:     "admin-secret",
		tokens:     ts,
	}
	srv.router = srv.buildRouter()
	return srv, ts, env
}

func TestAuthMiddleware_ScopedTokenGrantsAccess(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	// Provision a scoped token Secret directly.
	sec := newTokenSecret("claim-key-ac", "scoped-token-value",
		"tenant-z", "wl-z", "claim-ac",
		string(scope.WorkloadsRead), "")
	require.NoError(t, env.client.Create(env.ctx, sec))

	// Wait for the informer to index it.
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-token-value")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	req.Header.Set("Authorization", "Bearer scoped-token-value")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestAuthMiddleware_UnknownTokenRejected(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	req.Header.Set("Authorization", "Bearer not-issued")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Contains(t, body["error"], "invalid API key")
}

func TestAuthMiddleware_AdminKeyStillWorksAlongsideTokenStore(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	req.Header.Set("Authorization", "Bearer admin-secret")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestAuthMiddleware_MalformedHeaderRejected(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	// No "Bearer " prefix.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	req.Header.Set("Authorization", "admin-secret")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAuthMiddleware_AttachesAuthContextForScopedToken(t *testing.T) {
	env := setupEnvtest(t)
	defer env.cleanup()
	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(env.ctx)
	defer cancel()
	require.NoError(t, ts.Start(ctx))

	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "claim-key-ctx",
			Namespace: "default",
			Labels: map[string]string{
				claimtoken.LabelAPIToken: "true",
				claimtoken.LabelTenant:   "alice",
				claimtoken.LabelWorkload: "wl-ctx",
				claimtoken.LabelClaim:    "claim-ctx",
			},
			Annotations: map[string]string{
				claimtoken.AnnotationScopes: "agent-triggers:write,issues:write",
			},
		},
		Data: map[string][]byte{claimtoken.DataKey: []byte("t-ctx")},
	}
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := ts.Lookup("t-ctx")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	srv := &Server{
		client:    env.client,
		namespace: "default",
		apiKey:    "",
		tokens:    ts,
	}

	var captured AuthContext
	handler := srv.authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ac, _ := AuthFromContext(r.Context())
		captured = ac
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/whatever", nil)
	req.Header.Set("Authorization", "Bearer t-ctx")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, AuthScoped, captured.Kind)
	assert.Equal(t, "alice", captured.TenantID)
	assert.Equal(t, "wl-ctx", captured.Workload)
	assert.Equal(t, "claim-ctx", captured.ClaimID)
	require.Len(t, captured.Scopes, 2)
	assert.Equal(t, scope.AgentTriggersWrite, captured.Scopes[0])
	assert.Equal(t, scope.IssuesWrite, captured.Scopes[1])
}
