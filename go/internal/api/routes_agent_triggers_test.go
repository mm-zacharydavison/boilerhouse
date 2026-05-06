package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	"github.com/zdavison/boilerhouse/go/internal/scope"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
)

// agentTokenSetup creates a scoped token Secret and waits for the cache to
// see it. Returns the token value the test should use as Bearer.
func agentTokenSetup(t *testing.T, srv *Server, env envtestResult, claim, tenant, workload string, scopes ...string) string {
	t.Helper()
	tokenValue := fmt.Sprintf("tok-%s-%s", tenant, claim)
	scopeCSV := ""
	for i, sc := range scopes {
		if i > 0 {
			scopeCSV += ","
		}
		scopeCSV += sc
	}
	sec := newTokenSecret("claim-key-"+claim, tokenValue, tenant, workload, claim, scopeCSV, "")
	require.NoError(t, env.client.Create(env.ctx, sec))
	require.Eventually(t, func() bool {
		_, ok := srv.tokens.Lookup(tokenValue)
		return ok
	}, 2*time.Second, 25*time.Millisecond)
	return tokenValue
}

// createClaimWithOriginatingTrigger creates a BoilerhouseClaim CR in envtest
// with the originating-trigger annotation set, so resolveReplyContextForClaim
// has a Claim to look up.
func createClaimWithOriginatingTrigger(t *testing.T, env envtestResult, claimName, tenantID, workloadRef, originatingTrigger string) {
	t.Helper()
	annotations := map[string]string{}
	if originatingTrigger != "" {
		annotations[claimtoken.AnnotationOriginatingTrigger] = originatingTrigger
	}
	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:        claimName,
			Namespace:   "default",
			Annotations: annotations,
		},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    tenantID,
			WorkloadRef: workloadRef,
		},
	}
	require.NoError(t, env.client.Create(env.ctx, claim))
}

// createTelegramTrigger creates a BoilerhouseTrigger telegram trigger CR in
// envtest with the bot token literal in spec.config so reply-context
// resolution can copy it.
func createTelegramTrigger(t *testing.T, env envtestResult, name, tenantID, workloadRef, botToken string) {
	t.Helper()
	cfg := map[string]any{"botToken": botToken, "chatId": 12345}
	rawCfg, _ := json.Marshal(cfg)
	tr := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "telegram",
			WorkloadRef: workloadRef,
			Tenant:      &v1alpha1.TriggerTenant{Static: tenantID},
			Config:      &runtime.RawExtension{Raw: rawCfg},
		},
	}
	require.NoError(t, env.client.Create(env.ctx, tr))
}

func postJSON(t *testing.T, srv *Server, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func TestAgentTriggers_RequiresWriteScope(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	// Read-only scope should not allow POST.
	tok := agentTokenSetup(t, srv, env, "ro", "tenant-a", "wl-a",
		string(scope.AgentTriggersRead))

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
		Type:  "one-shot",
		RunAt: time.Now().Add(10 * time.Minute).Format(time.RFC3339),
		Label: "test",
	})
	assert.Equal(t, http.StatusForbidden, rec.Code)
}

func TestAgentTriggers_RejectsWebhookType(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	tok := agentTokenSetup(t, srv, env, "tw", "tenant-a", "wl-a",
		string(scope.AgentTriggersWrite))
	createClaimWithOriginatingTrigger(t, env, "tw", "tenant-a", "wl-a", "")

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
		Type:  "webhook",
		Label: "test",
	})
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "type not allowed")
}

func TestAgentTriggers_CronBelowMinIntervalRejected(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	tok := agentTokenSetup(t, srv, env, "cb", "tenant-a", "wl-a",
		string(scope.AgentTriggersWrite))
	createClaimWithOriginatingTrigger(t, env, "cb", "tenant-a", "wl-a", "")

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
		Type:     "cron",
		Schedule: "30s",
		Label:    "fast",
	})
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "schedule must be")
}

func TestAgentTriggers_OneShotInPastRejected(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	tok := agentTokenSetup(t, srv, env, "op", "tenant-a", "wl-a",
		string(scope.AgentTriggersWrite))
	createClaimWithOriginatingTrigger(t, env, "op", "tenant-a", "wl-a", "")

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
		Type:  "one-shot",
		RunAt: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
		Label: "past",
	})
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "future")
}

func TestAgentTriggers_OneShotBeyondHorizonRejected(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	tok := agentTokenSetup(t, srv, env, "fh", "tenant-a", "wl-a",
		string(scope.AgentTriggersWrite))
	createClaimWithOriginatingTrigger(t, env, "fh", "tenant-a", "wl-a", "")

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
		Type:  "one-shot",
		RunAt: time.Now().Add(365 * 24 * time.Hour).Format(time.RFC3339),
		Label: "way-future",
	})
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "within")
}

func TestAgentTriggers_HappyPathOneShotStampsLabelsAndCopiesReplyContext(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	tok := agentTokenSetup(t, srv, env, "hp", "tenant-h", "wl-h",
		string(scope.AgentTriggersWrite))
	createTelegramTrigger(t, env, "tg-main", "tenant-h", "wl-h", "bot-secret-xyz")
	createClaimWithOriginatingTrigger(t, env, "hp", "tenant-h", "wl-h", "tg-main")

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
		Type:    "one-shot",
		RunAt:   time.Now().Add(10 * time.Minute).Format(time.RFC3339),
		Payload: map[string]any{"task": "remind me about the deploy"},
		Label:   "deploy-reminder",
	})
	if rec.Code != http.StatusCreated {
		t.Logf("response body: %s", rec.Body.String())
	}
	require.Equal(t, http.StatusCreated, rec.Code)

	var resp agentTriggerResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "one-shot", resp.Type)
	assert.Equal(t, "deploy-reminder", resp.Label)
	assert.Equal(t, "Active", resp.Phase)

	// Verify the persisted CR has the right labels and replyContext.
	var stored v1alpha1.BoilerhouseTrigger
	require.NoError(t, env.client.Get(env.ctx,
		types.NamespacedName{Name: resp.Name, Namespace: "default"}, &stored))
	assert.Equal(t, claimtoken.OriginAgent, stored.Labels[claimtoken.LabelOrigin])
	assert.Equal(t, "tenant-h", stored.Labels[claimtoken.LabelCreatedByTenant])
	assert.Equal(t, "wl-h", stored.Spec.WorkloadRef)
	require.NotNil(t, stored.Spec.Tenant)
	assert.Equal(t, "tenant-h", stored.Spec.Tenant.Static)
	assert.Empty(t, stored.Spec.Tenant.From, "agents must not set tenant.from")

	require.NotNil(t, stored.Spec.Config)
	var cfg map[string]any
	require.NoError(t, json.Unmarshal(stored.Spec.Config.Raw, &cfg))
	rc, ok := cfg["replyContext"].(map[string]any)
	require.True(t, ok, "replyContext should be present")
	assert.Equal(t, "telegram", rc["adapter"])
	assert.Equal(t, "bot-secret-xyz", rc["botToken"])
}

func TestAgentTriggers_QuotaExceeded(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	// Tighten the policy to 2 to keep the test fast.
	srv.agentPolicy = AgentTriggerPolicy{
		AllowedTypes:         []string{"cron", "one-shot"},
		MinCronInterval:      5 * time.Minute,
		MaxTriggersPerTenant: 2,
		MaxOneShotHorizon:    30 * 24 * time.Hour,
		MinOneShotDelay:      1 * time.Minute,
	}

	tok := agentTokenSetup(t, srv, env, "qx", "tenant-q", "wl-q",
		string(scope.AgentTriggersWrite))
	createClaimWithOriginatingTrigger(t, env, "qx", "tenant-q", "wl-q", "")

	for i := 0; i < 2; i++ {
		rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
			Type:  "one-shot",
			RunAt: time.Now().Add(time.Duration(10+i) * time.Minute).Format(time.RFC3339),
			Label: fmt.Sprintf("t%d", i),
		})
		require.Equal(t, http.StatusCreated, rec.Code, "fill: %s", rec.Body.String())
	}

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
		Type:  "one-shot",
		RunAt: time.Now().Add(20 * time.Minute).Format(time.RFC3339),
		Label: "overflow",
	})
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "quota")
}

func TestAgentTriggers_ListReturnsOnlyOwnTenant(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	tokA := agentTokenSetup(t, srv, env, "la", "tenant-a", "wl-a",
		string(scope.AgentTriggersWrite), string(scope.AgentTriggersRead))
	createClaimWithOriginatingTrigger(t, env, "la", "tenant-a", "wl-a", "")
	tokB := agentTokenSetup(t, srv, env, "lb", "tenant-b", "wl-b",
		string(scope.AgentTriggersWrite), string(scope.AgentTriggersRead))
	createClaimWithOriginatingTrigger(t, env, "lb", "tenant-b", "wl-b", "")

	for _, tok := range []string{tokA, tokB} {
		rec := postJSON(t, srv, "/api/v1/agent-triggers", tok, agentTriggerRequest{
			Type:  "one-shot",
			RunAt: time.Now().Add(10 * time.Minute).Format(time.RFC3339),
			Label: "x",
		})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent-triggers", nil)
	req.Header.Set("Authorization", "Bearer "+tokA)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var items []agentTriggerResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))
	assert.Len(t, items, 1, "tenant-a should only see its own triggers")
}

func TestAgentTriggers_DeleteOtherTenantReturnsNotFound(t *testing.T) {
	srv, _, env := newAuthTestServer(t)
	defer env.cleanup()

	tokA := agentTokenSetup(t, srv, env, "da", "tenant-a", "wl-a",
		string(scope.AgentTriggersWrite), string(scope.AgentTriggersRead))
	createClaimWithOriginatingTrigger(t, env, "da", "tenant-a", "wl-a", "")
	tokB := agentTokenSetup(t, srv, env, "db", "tenant-b", "wl-b",
		string(scope.AgentTriggersWrite))
	createClaimWithOriginatingTrigger(t, env, "db", "tenant-b", "wl-b", "")

	rec := postJSON(t, srv, "/api/v1/agent-triggers", tokA, agentTriggerRequest{
		Type:  "one-shot",
		RunAt: time.Now().Add(10 * time.Minute).Format(time.RFC3339),
		Label: "a-trigger",
	})
	require.Equal(t, http.StatusCreated, rec.Code)
	var created agentTriggerResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))

	// Tenant B tries to delete tenant A's trigger.
	delReq := httptest.NewRequest(http.MethodDelete,
		"/api/v1/agent-triggers/"+created.Name, nil)
	delReq.Header.Set("Authorization", "Bearer "+tokB)
	delRec := httptest.NewRecorder()
	srv.ServeHTTP(delRec, delReq)
	assert.Equal(t, http.StatusNotFound, delRec.Code)

	// Tenant A can still find it.
	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/agent-triggers", nil)
	listReq.Header.Set("Authorization", "Bearer "+tokA)
	listRec := httptest.NewRecorder()
	srv.ServeHTTP(listRec, listReq)
	require.Equal(t, http.StatusOK, listRec.Code)
}
