package api

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// TestAcquireClaim_PendingClaimIsJoinedNotClobbered: a claim that is mid-
// provision (Pending, finalizer set — e.g. created by a concurrent request
// moments ago) must be returned for polling like an Active one, NOT deleted
// and recreated (which would kill the in-flight provision).
func TestAcquireClaim_PendingClaimIsJoinedNotClobbered(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	ctx := context.Background()

	inflight := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "claim-t1-wl1",
			Namespace:  "default",
			Finalizers: []string{"boilerhouse.dev/cleanup"},
		},
		Spec: v1alpha1.BoilerhouseClaimSpec{TenantId: "t1", WorkloadRef: "wl1"},
	}
	require.NoError(t, srv.client.Create(ctx, inflight))
	inflight.Status.Phase = "Pending"
	require.NoError(t, srv.client.Status().Update(ctx, inflight))
	origUID := inflight.UID

	got, _, err := srv.acquireClaim(ctx, "t1", "wl1", nil, nil)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "claim-t1-wl1", got.Name)

	var after v1alpha1.BoilerhouseClaim
	require.NoError(t, srv.client.Get(ctx,
		types.NamespacedName{Name: "claim-t1-wl1", Namespace: "default"}, &after))
	assert.Equal(t, origUID, after.UID, "pending claim was deleted and recreated")
	assert.True(t, after.DeletionTimestamp.IsZero(), "pending claim was marked for deletion")
}

// TestAcquireClaim_EmptyPhaseClaimIsJoinedNotClobbered: a claim so fresh the
// operator hasn't stamped Pending yet (phase "") is equally in-flight and must
// not be clobbered.
func TestAcquireClaim_EmptyPhaseClaimIsJoinedNotClobbered(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	ctx := context.Background()

	inflight := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "claim-t2-wl1", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "t2", WorkloadRef: "wl1"},
	}
	require.NoError(t, srv.client.Create(ctx, inflight))
	origUID := inflight.UID

	got, _, err := srv.acquireClaim(ctx, "t2", "wl1", nil, nil)
	require.NoError(t, err)
	require.NotNil(t, got)

	var after v1alpha1.BoilerhouseClaim
	require.NoError(t, srv.client.Get(ctx,
		types.NamespacedName{Name: "claim-t2-wl1", Namespace: "default"}, &after))
	assert.Equal(t, origUID, after.UID, "fresh claim was deleted and recreated")
}

// TestAcquireClaim_ReleasedClaimIsReplaced: the revive path still works — a
// Released claim IS stale and must be deleted and recreated.
func TestAcquireClaim_ReleasedClaimIsReplaced(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	ctx := context.Background()

	released := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "claim-t3-wl1",
			Namespace:  "default",
			Finalizers: []string{"boilerhouse.dev/cleanup"},
		},
		Spec: v1alpha1.BoilerhouseClaimSpec{TenantId: "t3", WorkloadRef: "wl1"},
	}
	require.NoError(t, srv.client.Create(ctx, released))
	released.Status.Phase = "Released"
	require.NoError(t, srv.client.Status().Update(ctx, released))
	origUID := released.UID

	got, outcome, err := srv.acquireClaim(ctx, "t3", "wl1", nil, nil)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, outcomeCreated, outcome)

	var after v1alpha1.BoilerhouseClaim
	require.NoError(t, srv.client.Get(ctx,
		types.NamespacedName{Name: "claim-t3-wl1", Namespace: "default"}, &after))
	assert.NotEqual(t, origUID, after.UID, "released claim should have been replaced")
}

// TestClaimSpec_RejectsUnsafeTenantId: TenantId flows into pod labels, claim
// names, and snapshot paths interpolated into shell commands — the CRD must
// reject anything beyond DNS-safe characters at admission.
func TestClaimSpec_RejectsUnsafeTenantId(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	ctx := context.Background()

	for _, bad := range []string{
		"x'; rm -rf /snapshots; '",
		"UPPER",
		"under_score",
		"-leading-dash",
		"trailing-dash-",
	} {
		claim := &v1alpha1.BoilerhouseClaim{
			ObjectMeta: metav1.ObjectMeta{Name: "claim-bad-tenant", Namespace: "default"},
			Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: bad, WorkloadRef: "wl1"},
		}
		err := srv.client.Create(ctx, claim)
		assert.Error(t, err, "tenantId %q must be rejected by CRD validation", bad)
	}

	good := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "claim-good-tenant", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "tg-12345.ok", WorkloadRef: "wl1"},
	}
	assert.NoError(t, srv.client.Create(ctx, good), "DNS-safe tenantId must be accepted")
}

// TestWorkloadNetwork_RejectsWildcardAllowlist: envoy's SNI passthrough dials
// the allowlisted hostname via STRICT_DNS — a wildcard like *.github.com can
// never resolve, so the CRD must reject it at admission instead of shipping a
// silently-broken proxy config.
func TestWorkloadNetwork_RejectsWildcardAllowlist(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	ctx := context.Background()

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-wildcard", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "alpine:3.21"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 128, DiskGb: 1},
			Network: &v1alpha1.WorkloadNetwork{
				Access:    "restricted",
				Allowlist: []string{"*.github.com"},
			},
		},
	}
	assert.Error(t, srv.client.Create(ctx, wl), "wildcard allowlist entries must be rejected")

	ok := wl.DeepCopy()
	ok.Name = "wl-concrete"
	ok.ResourceVersion = ""
	ok.Spec.Network.Allowlist = []string{"api.github.com"}
	assert.NoError(t, srv.client.Create(ctx, ok), "concrete allowlist domains must be accepted")
}
