//go:build e2e

package e2e

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOverlayRestore(t *testing.T) {
	tracker := &CrdTracker{}
	t.Cleanup(func() { tracker.Cleanup(t) })

	ctx := context.Background()

	// Create overlay workload.
	wlName := uniqueName("overlay-wl")
	wl := overlayWorkload(wlName)
	tracker.TrackWorkload(wlName)

	err := k8sClient.Create(ctx, wl)
	require.NoError(t, err, "creating overlay workload")

	_, err = waitForPhase("boilerhouseworkloads", wlName, "Ready", defaultTimeout)
	require.NoError(t, err, "workload should reach Ready")

	// First claim: write data.
	tenantId := uniqueName("tenant")
	claim1Name := uniqueName("overlay-claim1")
	claim1 := newClaim(claim1Name, tenantId, wlName)
	tracker.TrackClaim(claim1Name)

	err = k8sClient.Create(ctx, claim1)
	require.NoError(t, err, "creating first claim")

	status1, err := waitForPhase("boilerhouseclaims", claim1Name, "Active", defaultTimeout)
	require.NoError(t, err, "first claim should reach Active")

	instanceId1, _ := status1["instanceId"].(string)
	require.NotEmpty(t, instanceId1)

	// Wait for pod to be running before exec.
	err = waitForPodPhase(instanceId1, "Running", defaultTimeout)
	require.NoError(t, err, "first instance pod should be Running")

	// Write data to overlay dir.
	stdout, stderr, exitCode, err := kubectlExec(instanceId1, []string{
		"sh", "-c", "echo 'hello-overlay' > /data/test.txt",
	})
	require.NoError(t, err, "kubectl exec write should not error")
	require.Equal(t, 0, exitCode, "write exit code should be 0, stderr: %s", stderr)
	_ = stdout

	// Verify data was written.
	stdout, _, exitCode, err = kubectlExec(instanceId1, []string{"cat", "/data/test.txt"})
	require.NoError(t, err)
	require.Equal(t, 0, exitCode)
	require.Equal(t, "hello-overlay\n", stdout)

	// Delete first claim (pod gets deleted, PVC persists due to hibernate).
	err = k8sClient.Delete(ctx, claim1)
	require.NoError(t, err, "deleting first claim")

	err = waitForDeletion("boilerhouseclaims", claim1Name, defaultTimeout)
	require.NoError(t, err, "first claim should be deleted")

	err = waitForPodDeletion(instanceId1, defaultTimeout)
	require.NoError(t, err, "first instance pod should be deleted")

	// Second claim for same tenant: data should persist via PVC.
	claim2Name := uniqueName("overlay-claim2")
	claim2 := newClaim(claim2Name, tenantId, wlName)
	tracker.TrackClaim(claim2Name)

	err = k8sClient.Create(ctx, claim2)
	require.NoError(t, err, "creating second claim")

	status2, err := waitForPhase("boilerhouseclaims", claim2Name, "Active", defaultTimeout)
	require.NoError(t, err, "second claim should reach Active")

	instanceId2, _ := status2["instanceId"].(string)
	require.NotEmpty(t, instanceId2)

	err = waitForPodPhase(instanceId2, "Running", defaultTimeout)
	require.NoError(t, err, "second instance pod should be Running")

	// Read data from the overlay dir — should persist via PVC.
	stdout, stderr, exitCode, err = kubectlExec(instanceId2, []string{"cat", "/data/test.txt"})
	require.NoError(t, err, "kubectl exec read should not error")
	require.Equal(t, 0, exitCode, "read exit code should be 0, stderr: %s", stderr)
	require.Equal(t, "hello-overlay\n", stdout, "data should persist across claim cycles via PVC")

	// Verify source contains "+data" indicating PVC was reused.
	source, _ := status2["source"].(string)
	require.True(t, strings.Contains(source, "+data"),
		"source should contain '+data' indicating PVC reuse, got: %s", source)
}
