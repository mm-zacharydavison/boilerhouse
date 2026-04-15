//go:build e2e

package e2e

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMultiTenant_DistinctInstances(t *testing.T) {
	tracker := &CrdTracker{}
	t.Cleanup(func() { tracker.Cleanup(t) })

	ctx := context.Background()

	// Create workload.
	wlName := uniqueName("multi-wl")
	wl := minimalWorkload(wlName)
	tracker.TrackWorkload(wlName)

	err := k8sClient.Create(ctx, wl)
	require.NoError(t, err, "creating workload")

	_, err = waitForPhase("boilerhouseworkloads", wlName, "Ready", defaultTimeout)
	require.NoError(t, err, "workload should reach Ready")

	// Claim for tenant-a.
	tenantA := uniqueName("tenant-a")
	claimAName := uniqueName("multi-claim-a")
	claimA := newClaim(claimAName, tenantA, wlName)
	tracker.TrackClaim(claimAName)

	err = k8sClient.Create(ctx, claimA)
	require.NoError(t, err, "creating claim for tenant-a")

	statusA, err := waitForPhase("boilerhouseclaims", claimAName, "Active", defaultTimeout)
	require.NoError(t, err, "claim for tenant-a should reach Active")

	instanceIdA, _ := statusA["instanceId"].(string)
	require.NotEmpty(t, instanceIdA, "tenant-a claim should have instanceId")

	// Claim for tenant-b.
	tenantB := uniqueName("tenant-b")
	claimBName := uniqueName("multi-claim-b")
	claimB := newClaim(claimBName, tenantB, wlName)
	tracker.TrackClaim(claimBName)

	err = k8sClient.Create(ctx, claimB)
	require.NoError(t, err, "creating claim for tenant-b")

	statusB, err := waitForPhase("boilerhouseclaims", claimBName, "Active", defaultTimeout)
	require.NoError(t, err, "claim for tenant-b should reach Active")

	instanceIdB, _ := statusB["instanceId"].(string)
	require.NotEmpty(t, instanceIdB, "tenant-b claim should have instanceId")

	// Different tenants must get different instances.
	require.NotEqual(t, instanceIdA, instanceIdB,
		"two different tenants claiming the same workload should get distinct instances")
}
