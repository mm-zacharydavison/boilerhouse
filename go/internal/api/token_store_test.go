package api

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// waitFor polls until the predicate returns true or the timeout elapses.
// Used to bridge the small gap between Secret writes and informer delivery.
func waitFor(t *testing.T, timeout time.Duration, fn func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}

func newTokenSecret(name, token, tenant, workload, claim string, scopes string, expiresAt string) *corev1.Secret {
	annot := map[string]string{claimtoken.AnnotationScopes: scopes}
	if expiresAt != "" {
		annot[claimtoken.AnnotationExpiresAt] = expiresAt
	}
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: "default",
			Labels: map[string]string{
				claimtoken.LabelAPIToken: "true",
				claimtoken.LabelTenant:   tenant,
				claimtoken.LabelWorkload: workload,
				claimtoken.LabelClaim:    claim,
			},
			Annotations: annot,
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{claimtoken.DataKey: []byte(token)},
	}
}

func TestTokenStore_LookupLivesFromInformerCache(t *testing.T) {
	env := setupEnvtest(t)
	defer env.cleanup()

	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(env.ctx)
	defer cancel()
	require.NoError(t, ts.Start(ctx))

	// Create a token Secret after the cache is live.
	sec := newTokenSecret("claim-key-t1", "tokvalue-alpha",
		"tenant-a", "wl-a", "claim-t1",
		"agent-triggers:write,issues:write", "")
	require.NoError(t, env.client.Create(env.ctx, sec))

	var ac AuthContext
	ok := waitFor(t, 2*time.Second, func() bool {
		got, found := ts.Lookup("tokvalue-alpha")
		if found {
			ac = got
		}
		return found
	})
	require.True(t, ok, "informer should deliver the new Secret within timeout")

	assert.Equal(t, AuthScoped, ac.Kind)
	assert.Equal(t, "tenant-a", ac.TenantID)
	assert.Equal(t, "wl-a", ac.Workload)
	assert.Equal(t, "claim-t1", ac.ClaimID)
	assert.Len(t, ac.Scopes, 2)
}

func TestTokenStore_DeletePurgesFromCache(t *testing.T) {
	env := setupEnvtest(t)
	defer env.cleanup()

	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(env.ctx)
	defer cancel()
	require.NoError(t, ts.Start(ctx))

	sec := newTokenSecret("claim-key-t2", "tokvalue-beta",
		"tenant-b", "wl-b", "claim-t2", "health:read", "")
	require.NoError(t, env.client.Create(env.ctx, sec))

	require.True(t, waitFor(t, 2*time.Second, func() bool {
		_, ok := ts.Lookup("tokvalue-beta")
		return ok
	}))

	// Delete the Secret; lookup should eventually return false.
	require.NoError(t, env.client.Delete(env.ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "claim-key-t2", Namespace: "default"},
	}))
	require.True(t, waitFor(t, 2*time.Second, func() bool {
		_, ok := ts.Lookup("tokvalue-beta")
		return !ok
	}), "informer should purge deleted token")
}

func TestTokenStore_LookupUnknownToken(t *testing.T) {
	env := setupEnvtest(t)
	defer env.cleanup()

	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(env.ctx)
	defer cancel()
	require.NoError(t, ts.Start(ctx))

	_, ok := ts.Lookup("not-a-real-token")
	assert.False(t, ok)
}

func TestTokenStore_ExpiredTokenRejected(t *testing.T) {
	env := setupEnvtest(t)
	defer env.cleanup()

	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(env.ctx)
	defer cancel()
	require.NoError(t, ts.Start(ctx))

	past := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	sec := newTokenSecret("claim-key-exp", "tokvalue-exp",
		"tenant-x", "wl-x", "claim-exp", "health:read", past)
	require.NoError(t, env.client.Create(env.ctx, sec))

	// Give the informer a moment to deliver.
	time.Sleep(250 * time.Millisecond)
	_, ok := ts.Lookup("tokvalue-exp")
	assert.False(t, ok, "expired token must be rejected even after informer delivery")
}

func TestTokenStore_ColdMissFallsBackToList(t *testing.T) {
	env := setupEnvtest(t)
	defer env.cleanup()

	// Create Secret BEFORE starting the store so we can verify cold-miss
	// behaviour (the informer should fill it in on sync, but regardless the
	// list fallback must also be able to locate it).
	sec := newTokenSecret("claim-key-pre", "tokvalue-pre",
		"tenant-pre", "wl-pre", "claim-pre", "health:read", "")
	require.NoError(t, env.client.Create(env.ctx, sec))

	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)

	// Clear the in-memory cache post-start to force the cold path.
	ctx, cancel := context.WithCancel(env.ctx)
	defer cancel()
	require.NoError(t, ts.Start(ctx))
	ts.mu.Lock()
	ts.entries = map[[32]byte]tokenEntry{}
	ts.mu.Unlock()

	ac, ok := ts.Lookup("tokvalue-pre")
	require.True(t, ok, "cold lookup should find the Secret via label-scoped List")
	assert.Equal(t, "tenant-pre", ac.TenantID)
}

func TestTokenStore_UpdatedSecretReflectsInLookup(t *testing.T) {
	env := setupEnvtest(t)
	defer env.cleanup()

	ts, err := NewTokenStore(env.restConfig, "default")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(env.ctx)
	defer cancel()
	require.NoError(t, ts.Start(ctx))

	sec := newTokenSecret("claim-key-upd", "tokvalue-upd",
		"tenant-u", "wl-u", "claim-u", "health:read", "")
	require.NoError(t, env.client.Create(env.ctx, sec))

	require.True(t, waitFor(t, 2*time.Second, func() bool {
		_, ok := ts.Lookup("tokvalue-upd")
		return ok
	}))

	// Update scopes annotation; re-lookup should reflect the new set.
	var current corev1.Secret
	require.NoError(t, env.client.Get(env.ctx,
		types.NamespacedName{Name: "claim-key-upd", Namespace: "default"}, &current))
	current.Annotations[claimtoken.AnnotationScopes] = "agent-triggers:read"
	require.NoError(t, env.client.Update(env.ctx, &current))

	require.True(t, waitFor(t, 2*time.Second, func() bool {
		ac, ok := ts.Lookup("tokvalue-upd")
		if !ok {
			return false
		}
		return len(ac.Scopes) == 1 && string(ac.Scopes[0]) == "agent-triggers:read"
	}), "updated scope annotation should propagate to cache")
}
