//go:build e2e

package e2e

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstanceLifecycle(t *testing.T) {
	tracker := &CrdTracker{}
	t.Cleanup(func() { tracker.Cleanup(t) })

	ctx := context.Background()

	// Create workload.
	wlName := uniqueName("lifecycle-wl")
	wl := minimalWorkload(wlName)
	tracker.TrackWorkload(wlName)

	err := k8sClient.Create(ctx, wl)
	require.NoError(t, err, "creating workload")

	// Wait for workload to be Ready.
	_, err = waitForPhase("boilerhouseworkloads", wlName, "Ready", defaultTimeout)
	require.NoError(t, err, "workload should reach Ready")

	// Create claim.
	claimName := uniqueName("lifecycle-claim")
	tenantId := uniqueName("tenant")
	claim := newClaim(claimName, tenantId, wlName)
	tracker.TrackClaim(claimName)

	err = k8sClient.Create(ctx, claim)
	require.NoError(t, err, "creating claim")

	// Wait for claim to be Active.
	status, err := waitForPhase("boilerhouseclaims", claimName, "Active", defaultTimeout)
	require.NoError(t, err, "claim should reach Active")

	// Verify instance pod is running.
	instanceId, ok := status["instanceId"].(string)
	require.True(t, ok, "claim status should have instanceId")
	require.NotEmpty(t, instanceId, "instanceId should not be empty")

	err = waitForPodPhase(instanceId, "Running", defaultTimeout)
	require.NoError(t, err, "instance pod should be Running")

	// Delete claim.
	err = k8sClient.Delete(ctx, claim)
	require.NoError(t, err, "deleting claim")

	// Wait for claim deletion.
	err = waitForDeletion("boilerhouseclaims", claimName, defaultTimeout)
	require.NoError(t, err, "claim should be deleted")

	// Verify pod is cleaned up.
	err = waitForPodDeletion(instanceId, defaultTimeout)
	require.NoError(t, err, "instance pod should be deleted after claim deletion")
}
