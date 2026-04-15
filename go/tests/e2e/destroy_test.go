//go:build e2e

package e2e

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestDestroy_WorkloadBlockedByActiveClaim(t *testing.T) {
	tracker := &CrdTracker{}
	t.Cleanup(func() { tracker.Cleanup(t) })

	ctx := context.Background()

	// Create workload.
	wlName := uniqueName("destroy-wl")
	wl := minimalWorkload(wlName)
	tracker.TrackWorkload(wlName)

	err := k8sClient.Create(ctx, wl)
	require.NoError(t, err, "creating workload")

	_, err = waitForPhase("boilerhouseworkloads", wlName, "Ready", defaultTimeout)
	require.NoError(t, err, "workload should reach Ready")

	// Create claim.
	claimName := uniqueName("destroy-claim")
	tenantId := uniqueName("tenant")
	claim := newClaim(claimName, tenantId, wlName)
	tracker.TrackClaim(claimName)

	err = k8sClient.Create(ctx, claim)
	require.NoError(t, err, "creating claim")

	_, err = waitForPhase("boilerhouseclaims", claimName, "Active", defaultTimeout)
	require.NoError(t, err, "claim should reach Active")

	// Try to delete the workload while the claim is active.
	// The finalizer should prevent actual deletion.
	err = k8sClient.Delete(ctx, wl)
	require.NoError(t, err, "delete workload request should succeed (marks for deletion)")

	// Verify workload still exists after 3 seconds (blocked by finalizer).
	time.Sleep(3 * time.Second)
	exists, err := resourceExists("boilerhouseworkloads", wlName)
	require.NoError(t, err)
	require.True(t, exists, "workload should still exist while claim is active (blocked by finalizer)")

	// Delete the claim first.
	err = k8sClient.Delete(ctx, claim)
	require.NoError(t, err, "deleting claim")

	err = waitForDeletion("boilerhouseclaims", claimName, defaultTimeout)
	require.NoError(t, err, "claim should be deleted")

	// Now the workload deletion should complete (finalizer unblocked).
	err = waitForDeletion("boilerhouseworkloads", wlName, defaultTimeout)
	require.NoError(t, err, "workload should be deleted after claim is removed")
}
