package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	"github.com/zdavison/boilerhouse/go/internal/scope"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
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

func TestAuthMiddleware_ScopedTokenBlockedFromAdminRoute(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	// Even a token with WorkloadsRead scope must not hit /workloads —
	// scoped tokens are restricted to the cron-trigger surface for now.
	sec := newTokenSecret("claim-key-ac", "scoped-token-value",
		"tenant-z", "wl-z", "claim-ac",
		string(scope.WorkloadsRead), "")
	require.NoError(t, env.client.Create(env.ctx, sec))

	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-token-value")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil)
	req.Header.Set("Authorization", "Bearer scoped-token-value")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Contains(t, body["error"], "admin access required")
}

func TestAuthMiddleware_ScopedTokenCanListOwnTriggers(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	sec := newTokenSecret("claim-key-tr", "scoped-trigger-tok",
		"tenant-z", "wl-z", "claim-tr",
		string(scope.AgentTriggersRead), "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-trigger-tok")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/triggers", nil)
	req.Header.Set("Authorization", "Bearer scoped-trigger-tok")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestAuthMiddleware_ScopedTokenMissingScopeRejected(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	// Token has read-only; POST requires write.
	sec := newTokenSecret("claim-key-ro", "scoped-ro-tok",
		"tenant-z", "wl-z", "claim-ro",
		string(scope.AgentTriggersRead), "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-ro-tok")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/triggers", nil)
	req.Header.Set("Authorization", "Bearer scoped-ro-tok")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Contains(t, body["error"], "missing scope")
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

func TestCreateTrigger_ScopedRejectsNonCronType(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	sec := newTokenSecret("claim-key-wt", "scoped-wt-tok",
		"tenant-z", "wl-z", "claim-wt",
		string(scope.AgentTriggersWrite), "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-wt-tok")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	body, _ := json.Marshal(triggerRequest{
		Name: "nope",
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "webhook",
			WorkloadRef: "wl-z",
			Tenant:      &v1alpha1.TriggerTenant{Static: "tenant-z"},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/triggers", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer scoped-wt-tok")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "cron")
}

func TestCreateTrigger_ScopedRejectsOtherTenant(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	sec := newTokenSecret("claim-key-ot", "scoped-ot-tok",
		"tenant-a", "wl-a", "claim-ot",
		string(scope.AgentTriggersWrite), "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-ot-tok")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	body, _ := json.Marshal(triggerRequest{
		Name: "cross-tenant",
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "cron",
			WorkloadRef: "wl-a",
			Tenant:      &v1alpha1.TriggerTenant{Static: "tenant-b"},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/triggers", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer scoped-ot-tok")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "tenant.static")
}

func TestCreateTrigger_ScopedRejectsPayloadTenantExtraction(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	sec := newTokenSecret("claim-key-pe", "scoped-pe-tok",
		"tenant-a", "wl-a", "claim-pe",
		string(scope.AgentTriggersWrite), "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-pe-tok")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	// Even if Static matches, setting From lets the trigger fire on
	// whatever tenant the event payload specifies — must be rejected.
	body, _ := json.Marshal(triggerRequest{
		Name: "payload-exfil",
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "cron",
			WorkloadRef: "wl-a",
			Tenant: &v1alpha1.TriggerTenant{
				Static: "tenant-a",
				From:   "body.tenant",
			},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/triggers", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer scoped-pe-tok")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
}

func TestCreateTrigger_ScopedHappyPathStampsLabels(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	sec := newTokenSecret("claim-key-hp", "scoped-hp-tok",
		"tenant-h", "wl-h", "claim-hp",
		string(scope.AgentTriggersWrite), "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-hp-tok")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	body, _ := json.Marshal(triggerRequest{
		Name: "daily-scan",
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "cron",
			WorkloadRef: "wl-h",
			Tenant:      &v1alpha1.TriggerTenant{Static: "tenant-h"},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/triggers", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer scoped-hp-tok")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)

	var stored v1alpha1.BoilerhouseTrigger
	require.NoError(t, env.client.Get(env.ctx, types.NamespacedName{
		Name: "daily-scan", Namespace: "default",
	}, &stored))
	assert.Equal(t, "tenant-h", stored.Labels[claimtoken.LabelTenant])
	assert.Equal(t, "wl-h", stored.Labels[claimtoken.LabelWorkload])
}

func TestGetTrigger_ScopedHidesOtherTenantsAs404(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	// Admin creates a trigger owned by tenant-a.
	other := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "a-trigger", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "cron",
			WorkloadRef: "wl-a",
			Tenant:      &v1alpha1.TriggerTenant{Static: "tenant-a"},
		},
	}
	require.NoError(t, env.client.Create(env.ctx, other))

	// Scoped token for tenant-b tries to read it.
	sec := newTokenSecret("claim-key-hd", "scoped-hd-tok",
		"tenant-b", "wl-b", "claim-hd",
		string(scope.AgentTriggersRead), "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup("scoped-hd-tok")
		return ok
	}, 2*time.Second, 25*time.Millisecond)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/triggers/a-trigger", nil)
	req.Header.Set("Authorization", "Bearer scoped-hd-tok")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
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
