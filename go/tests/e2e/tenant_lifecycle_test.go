//go:build e2e

package e2e

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTenantLifecycle_RecreateGetsDifferentInstance(t *testing.T) {
	tracker := &CrdTracker{}
	t.Cleanup(func() { tracker.Cleanup(t) })

	ctx := context.Background()

	// Create workload.
	wlName := uniqueName("tenant-wl")
	wl := minimalWorkload(wlName)
	tracker.TrackWorkload(wlName)

	err := k8sClient.Create(ctx, wl)
	require.NoError(t, err, "creating workload")

	_, err = waitForPhase("boilerhouseworkloads", wlName, "Ready", defaultTimeout)
	require.NoError(t, err, "workload should reach Ready")

	// First claim for tenant-1.
	tenantId := uniqueName("tenant")
	claim1Name := uniqueName("tenant-claim1")
	claim1 := newClaim(claim1Name, tenantId, wlName)
	tracker.TrackClaim(claim1Name)

	err = k8sClient.Create(ctx, claim1)
	require.NoError(t, err, "creating first claim")

	status1, err := waitForPhase("boilerhouseclaims", claim1Name, "Active", defaultTimeout)
	require.NoError(t, err, "first claim should reach Active")

	instanceId1, _ := status1["instanceId"].(string)
	require.NotEmpty(t, instanceId1, "first claim should have instanceId")

	// Delete first claim.
	err = k8sClient.Delete(ctx, claim1)
	require.NoError(t, err, "deleting first claim")

	err = waitForDeletion("boilerhouseclaims", claim1Name, defaultTimeout)
	require.NoError(t, err, "first claim should be deleted")

	// Wait for pod cleanup.
	err = waitForPodDeletion(instanceId1, defaultTimeout)
	require.NoError(t, err, "first instance pod should be deleted")

	// Second claim for the same tenant.
	claim2Name := uniqueName("tenant-claim2")
	claim2 := newClaim(claim2Name, tenantId, wlName)
	tracker.TrackClaim(claim2Name)

	err = k8sClient.Create(ctx, claim2)
	require.NoError(t, err, "creating second claim")

	status2, err := waitForPhase("boilerhouseclaims", claim2Name, "Active", defaultTimeout)
	require.NoError(t, err, "second claim should reach Active")

	instanceId2, _ := status2["instanceId"].(string)
	require.NotEmpty(t, instanceId2, "second claim should have instanceId")

	// Different instances because the first was fully deleted (no overlay persistence).
	require.NotEqual(t, instanceId1, instanceId2,
		"re-claiming the same tenant should produce a different instanceId")
}
