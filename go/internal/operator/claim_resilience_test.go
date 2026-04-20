package operator

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// failingSnapshotter is a Snapshotter whose ExtractAndStore fails for the
// first failUntilAttempt-1 calls, then succeeds. Set failUntilAttempt to a
// very large number for "always fails".
type failingSnapshotter struct {
	extractAttempts  int
	failUntilAttempt int // succeed on this attempt and after; 0 == always fail
}

func (f *failingSnapshotter) HasSnapshot(_ context.Context, _, _ string) (bool, error) {
	return false, nil
}
func (f *failingSnapshotter) InjectSnapshot(_ context.Context, _, _, _ string) error {
	return nil
}
func (f *failingSnapshotter) ExtractAndStore(_ context.Context, _, _, _ string, _ []string) error {
	f.extractAttempts++
	if f.failUntilAttempt > 0 && f.extractAttempts >= f.failUntilAttempt {
		return nil
	}
	return errors.New("simulated extract failure")
}
func (f *failingSnapshotter) DeleteSnapshot(_ context.Context, _, _ string) error {
	return nil
}

// hibernateOverlayWorkload returns a workload spec with hibernate idle action
// and one overlay dir, so release attempts a snapshot extract.
func hibernateOverlayWorkload(name string, idleSeconds int) *v1alpha1.BoilerhouseWorkload {
	return &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
			Network: &v1alpha1.WorkloadNetwork{
				Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}},
			},
			Filesystem: &v1alpha1.WorkloadFilesystem{
				OverlayDirs: []string{"/data"},
			},
			Idle: &v1alpha1.WorkloadIdle{
				TimeoutSeconds: idleSeconds,
				Action:         "hibernate",
			},
		},
	}
}

// TestClaimController_IdleReleaseExtractionFailureKeepsPod reproduces the
// data-loss bug: when snapshot extraction fails during idle release, the
// reconciler currently deletes the Pod anyway and marks the claim Released —
// destroying the only copy of the tenant's overlay state.
//
// Required behavior: keep the Pod alive, mark the claim ReleaseFailed, so a
// subsequent reconcile or manual intervention can retry extraction.
func TestClaimController_IdleReleaseExtractionFailureKeepsPod(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wl := hibernateOverlayWorkload("idle-rel-fail-wl", 1)
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlKey := types.NamespacedName{Name: wl.Name, Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	snap := &failingSnapshotter{}
	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "idle-rel-fail-claim", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "amy",
			WorkloadRef: wl.Name,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{
		Client:              k8sClient,
		Scheme:              k8sClient.Scheme(),
		Snapshots:           snap,
		ExtractRetryBackoff: []time.Duration{0, 0, 0},
	}
	claimKey := types.NamespacedName{Name: claim.Name, Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	var active v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &active))
	require.Equal(t, "Active", active.Status.Phase, "precondition: claim must reach Active")

	// Force idle: backdate last-activity so handleActive triggers releaseClaim.
	if active.Annotations == nil {
		active.Annotations = map[string]string{}
	}
	active.Annotations[annotationLastActivity] = time.Now().Add(-1 * time.Hour).Format(time.RFC3339)
	require.NoError(t, k8sClient.Update(ctx, &active))

	// Reconcile — handleActive sees idle, calls releaseClaim, which calls ExtractAndStore (fails).
	_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
	require.NoError(t, err)

	assert.Equal(t, 3, snap.extractAttempts, "ExtractAndStore should be retried before giving up")

	// CRITICAL: Pod must NOT be deleted — the overlay would be lost.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelTenant: "amy", LabelWorkload: wl.Name}))
	assert.Len(t, podList.Items, 1,
		"Pod must remain alive when extraction fails; deleting it would destroy overlay data")

	// CRITICAL: Claim phase must reflect the failure, not pretend success.
	var afterRelease v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &afterRelease))
	assert.Equal(t, "ReleaseFailed", afterRelease.Status.Phase,
		"claim must transition to ReleaseFailed (got %q)", afterRelease.Status.Phase)
}

// TestClaimController_IdleReleaseExtractionRetrySucceeds proves the retry
// loop actually retries: first two attempts fail, third succeeds, claim ends
// up Released as on the happy path.
func TestClaimController_IdleReleaseExtractionRetrySucceeds(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wl := hibernateOverlayWorkload("idle-rel-retry-wl", 1)
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlKey := types.NamespacedName{Name: wl.Name, Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	snap := &failingSnapshotter{failUntilAttempt: 3} // succeed on the 3rd call
	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "idle-rel-retry-claim", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "carol",
			WorkloadRef: wl.Name,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{
		Client:              k8sClient,
		Scheme:              k8sClient.Scheme(),
		Snapshots:           snap,
		ExtractRetryBackoff: []time.Duration{0, 0, 0},
	}
	claimKey := types.NamespacedName{Name: claim.Name, Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	var active v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &active))
	require.Equal(t, "Active", active.Status.Phase)

	if active.Annotations == nil {
		active.Annotations = map[string]string{}
	}
	active.Annotations[annotationLastActivity] = time.Now().Add(-1 * time.Hour).Format(time.RFC3339)
	require.NoError(t, k8sClient.Update(ctx, &active))

	_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
	require.NoError(t, err)

	assert.Equal(t, 3, snap.extractAttempts, "should retry until success on the 3rd attempt")

	// On success, Pod is deleted and claim moves to Released.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelTenant: "carol", LabelWorkload: wl.Name}))
	assert.Empty(t, podList.Items, "Pod should be deleted on successful release")

	var afterRelease v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &afterRelease))
	assert.Equal(t, "Released", afterRelease.Status.Phase)
}

// TestClaimController_DeletionExtractionFailureBlocksFinalizer reproduces the
// same data-loss bug on the finalizer/deletion path: handleDeletion currently
// logs the extract error, deletes the Pod, and removes the finalizer — letting
// the Claim be garbage collected with no record that the snapshot was lost.
//
// Required behavior: refuse to delete the Pod, refuse to remove the finalizer,
// so future reconciles can retry.
func TestClaimController_DeletionExtractionFailureBlocksFinalizer(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wl := hibernateOverlayWorkload("del-rel-fail-wl", 60)
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlKey := types.NamespacedName{Name: wl.Name, Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	snap := &failingSnapshotter{}
	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "del-rel-fail-claim", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "ben",
			WorkloadRef: wl.Name,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{
		Client:              k8sClient,
		Scheme:              k8sClient.Scheme(),
		Snapshots:           snap,
		ExtractRetryBackoff: []time.Duration{0, 0, 0},
	}
	claimKey := types.NamespacedName{Name: claim.Name, Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	var active v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &active))
	require.Equal(t, "Active", active.Status.Phase, "precondition: claim must reach Active")

	require.NoError(t, k8sClient.Delete(ctx, &active))

	// Reconcile the deletion — handleDeletion attempts extract, fails, must hold the finalizer.
	_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
	require.NoError(t, err)

	assert.Equal(t, 3, snap.extractAttempts, "ExtractAndStore should be retried before giving up")

	// CRITICAL: Pod must still exist.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelTenant: "ben", LabelWorkload: wl.Name}))
	assert.Len(t, podList.Items, 1,
		"Pod must remain alive when extraction fails during deletion")

	// CRITICAL: Claim must still exist with the finalizer held back.
	var afterDelete v1alpha1.BoilerhouseClaim
	err = k8sClient.Get(ctx, claimKey, &afterDelete)
	require.NoError(t, err, "Claim should still exist while finalizer is held back")
	assert.Contains(t, afterDelete.Finalizers, finalizerName,
		"finalizer must remain so a future reconcile can retry extraction")
}
