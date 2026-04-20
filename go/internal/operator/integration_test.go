package operator

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// reconcileN calls Reconcile up to n times, stopping early if the returned
// result has no requeue signal. This is needed because controllers that add
// finalizers or update status return Requeue before doing the real work.
func reconcileN(t *testing.T, r reconcile.Reconciler, key types.NamespacedName, n int) {
	t.Helper()
	ctx := contextFromT(t)
	for i := 0; i < n; i++ {
		result, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		require.NoError(t, err, "reconcile attempt %d", i+1)
		if !result.Requeue && result.RequeueAfter == 0 {
			return
		}
	}
}

// reconcileUntilPhase calls Reconcile on the claim reconciler until the claim
// reaches the target phase, or fails after maxAttempts.
func reconcileClaimUntilPhase(t *testing.T, r *ClaimReconciler, k8sClient client.Client, key types.NamespacedName, targetPhase string, maxAttempts int) {
	t.Helper()
	ctx := contextFromT(t)
	for i := 0; i < maxAttempts; i++ {
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		require.NoError(t, err, "reconcile attempt %d", i+1)

		// envtest has no kubelet, so pods never gain a PodIP on their own.
		// The claim reconciler now refuses to activate without a PodIP,
		// so simulate it by patching any pod in the ns that still has an
		// empty status.podIP.
		populateEmptyPodIPs(t, ctx, k8sClient, key.Namespace)

		var claim v1alpha1.BoilerhouseClaim
		if err := k8sClient.Get(ctx, key, &claim); err != nil {
			continue
		}
		if claim.Status.Phase == targetPhase {
			return
		}
	}
	t.Fatalf("claim %s did not reach phase %q after %d reconciles", key, targetPhase, maxAttempts)
}

// populateEmptyPodIPs simulates kubelet assigning PodIPs + marking pods
// Running in envtest. Called between reconciles so that claim activation
// paths that depend on PodIP and PodPhase == Running can complete.
func populateEmptyPodIPs(t *testing.T, ctx context.Context, k8sClient client.Client, namespace string) {
	t.Helper()
	var pods corev1.PodList
	if err := k8sClient.List(ctx, &pods, client.InNamespace(namespace)); err != nil {
		return
	}
	for i := range pods.Items {
		p := &pods.Items[i]
		if p.Status.PodIP != "" && p.Status.Phase == corev1.PodRunning {
			continue
		}
		if p.Status.PodIP == "" {
			// Derive a deterministic fake IP from the pod name.
			var last int
			for _, c := range p.Name {
				last = (last*31 + int(c)) & 0xFF
			}
			if last == 0 {
				last = 1
			}
			p.Status.PodIP = fmt.Sprintf("10.244.0.%d", last)
		}
		if p.Status.Phase != corev1.PodRunning {
			p.Status.Phase = corev1.PodRunning
		}
		_ = k8sClient.Status().Update(ctx, p)
	}
}

// reconcileWorkloadUntilPhase calls Reconcile on the workload reconciler until
// the workload reaches the target phase, or fails after maxAttempts.
func reconcileWorkloadUntilPhase(t *testing.T, r *WorkloadReconciler, k8sClient client.Client, key types.NamespacedName, targetPhase string, maxAttempts int) {
	t.Helper()
	ctx := contextFromT(t)
	for i := 0; i < maxAttempts; i++ {
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		require.NoError(t, err, "reconcile attempt %d", i+1)

		var wl v1alpha1.BoilerhouseWorkload
		if err := k8sClient.Get(ctx, key, &wl); err != nil {
			continue
		}
		if wl.Status.Phase == targetPhase {
			return
		}
	}
	t.Fatalf("workload %s did not reach phase %q after %d reconciles", key, targetPhase, maxAttempts)
}

// contextFromT returns a background context. Named to match the pattern used
// throughout this package's tests.
func contextFromT(_ *testing.T) context.Context {
	return context.Background()
}

// ---------------------------------------------------------------------------
// 1. TestIntegration_InstanceLifecycle
// ---------------------------------------------------------------------------

func TestIntegration_InstanceLifecycle(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	claimReconciler := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}

	// Create a workload and reconcile to Ready.
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "lifecycle-wl", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image:   v1alpha1.WorkloadImage{Ref: "alpine:3.19"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs: 1, MemoryMb: 64, DiskGb: 1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "sleep 3600"},
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	wlKey := types.NamespacedName{Name: "lifecycle-wl", Namespace: "default"}
	reconcileWorkloadUntilPhase(t, wlReconciler, k8sClient, wlKey, "Ready", 5)

	// Verify workload is Ready.
	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, wlKey, &readyWl))
	require.Equal(t, "Ready", readyWl.Status.Phase)

	// Create a claim and reconcile to Active.
	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "lifecycle-claim", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-lc",
			WorkloadRef: "lifecycle-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	claimKey := types.NamespacedName{Name: "lifecycle-claim", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claimKey, "Active", 10)

	// Verify claim is Active with an instanceId.
	var activeClaim v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &activeClaim))
	assert.Equal(t, "Active", activeClaim.Status.Phase)
	assert.NotEmpty(t, activeClaim.Status.InstanceId)

	instanceId := activeClaim.Status.InstanceId

	// Verify Pod exists with correct labels.
	var pod corev1.Pod
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: instanceId, Namespace: "default"}, &pod))
	assert.Equal(t, "tenant-lc", pod.Labels[LabelTenant])
	assert.Equal(t, "lifecycle-wl", pod.Labels[LabelWorkload])
	assert.Equal(t, "true", pod.Labels[LabelManaged])

	// Delete the claim and reconcile the deletion.
	require.NoError(t, k8sClient.Delete(ctx, &activeClaim))
	reconcileN(t, claimReconciler, claimKey, 5)

	// Verify claim is fully deleted (finalizer removed).
	var deletedClaim v1alpha1.BoilerhouseClaim
	err := k8sClient.Get(ctx, claimKey, &deletedClaim)
	assert.True(t, apierrors.IsNotFound(err), "claim should be deleted after finalizer removal")

	// Verify Pod no longer exists.
	var deletedPod corev1.Pod
	err = k8sClient.Get(ctx, types.NamespacedName{Name: instanceId, Namespace: "default"}, &deletedPod)
	assert.True(t, apierrors.IsNotFound(err), "pod should be deleted after claim deletion")
}

// ---------------------------------------------------------------------------
// 2. TestIntegration_TenantRecreateGetsDifferentInstance
// ---------------------------------------------------------------------------

func TestIntegration_TenantRecreateGetsDifferentInstance(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	claimReconciler := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}

	// Create workload and reconcile to Ready.
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "recreate-wl", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image:   v1alpha1.WorkloadImage{Ref: "alpine:3.19"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs: 1, MemoryMb: 64, DiskGb: 1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "sleep 3600"},
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	wlKey := types.NamespacedName{Name: "recreate-wl", Namespace: "default"}
	reconcileWorkloadUntilPhase(t, wlReconciler, k8sClient, wlKey, "Ready", 5)

	// First claim for tenant-a.
	claim1 := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "recreate-claim1", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-a",
			WorkloadRef: "recreate-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim1))

	claim1Key := types.NamespacedName{Name: "recreate-claim1", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claim1Key, "Active", 10)

	var activeClaim1 v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claim1Key, &activeClaim1))
	instanceId1 := activeClaim1.Status.InstanceId
	require.NotEmpty(t, instanceId1)

	// Delete first claim and reconcile cleanup.
	require.NoError(t, k8sClient.Delete(ctx, &activeClaim1))
	reconcileN(t, claimReconciler, claim1Key, 5)

	// Verify first Pod is gone.
	var deletedPod corev1.Pod
	err := k8sClient.Get(ctx, types.NamespacedName{Name: instanceId1, Namespace: "default"}, &deletedPod)
	require.True(t, apierrors.IsNotFound(err), "first pod should be deleted")

	// Second claim for the same tenant-a.
	claim2 := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "recreate-claim2", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-a",
			WorkloadRef: "recreate-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim2))

	claim2Key := types.NamespacedName{Name: "recreate-claim2", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claim2Key, "Active", 10)

	var activeClaim2 v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claim2Key, &activeClaim2))
	instanceId2 := activeClaim2.Status.InstanceId
	require.NotEmpty(t, instanceId2)

	// Different instances because the first was fully deleted.
	assert.NotEqual(t, instanceId1, instanceId2,
		"re-claiming the same tenant should produce a different instanceId")
}

// ---------------------------------------------------------------------------
// 3. TestIntegration_OverlayEmptyDir
// ---------------------------------------------------------------------------

func TestIntegration_OverlayEmptyDir(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	claimReconciler := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}

	// Create overlay workload (filesystem.overlayDirs: ["/data"], idle.action: hibernate).
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "overlay-wl", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image:   v1alpha1.WorkloadImage{Ref: "alpine:3.19"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs: 1, MemoryMb: 64, DiskGb: 1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "sleep 3600"},
			},
			Filesystem: &v1alpha1.WorkloadFilesystem{
				OverlayDirs: []string{"/data"},
			},
			Idle: &v1alpha1.WorkloadIdle{
				Action: "hibernate",
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	wlKey := types.NamespacedName{Name: "overlay-wl", Namespace: "default"}
	reconcileWorkloadUntilPhase(t, wlReconciler, k8sClient, wlKey, "Ready", 5)

	// First claim for tenant-overlay. No SnapshotManager, so source is "cold".
	claim1 := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "overlay-claim1", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-overlay",
			WorkloadRef: "overlay-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim1))

	claim1Key := types.NamespacedName{Name: "overlay-claim1", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claim1Key, "Active", 10)

	var activeClaim1 v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claim1Key, &activeClaim1))
	instanceId1 := activeClaim1.Status.InstanceId
	require.NotEmpty(t, instanceId1)

	// Cold boot (snapshot-based restore requires kubectl, unavailable in envtest).
	assert.Equal(t, "cold", activeClaim1.Status.Source,
		"source should be cold (snapshot injection requires live cluster)")

	// Verify Pod is created with emptyDir volume for overlay.
	var pod1 corev1.Pod
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: instanceId1, Namespace: "default"}, &pod1))
	require.Len(t, pod1.Spec.Volumes, 1, "pod should have one emptyDir volume")
	assert.Equal(t, "overlay-0", pod1.Spec.Volumes[0].Name)
	assert.NotNil(t, pod1.Spec.Volumes[0].EmptyDir)

	// Verify volume mount on container.
	require.NotEmpty(t, pod1.Spec.Containers[0].VolumeMounts)
	assert.Equal(t, "/data", pod1.Spec.Containers[0].VolumeMounts[0].MountPath)

	// Delete the claim and reconcile.
	require.NoError(t, k8sClient.Delete(ctx, &activeClaim1))
	reconcileN(t, claimReconciler, claim1Key, 5)

	// Verify Pod is deleted.
	var deletedPod corev1.Pod
	err := k8sClient.Get(ctx, types.NamespacedName{Name: instanceId1, Namespace: "default"}, &deletedPod)
	assert.True(t, apierrors.IsNotFound(err), "pod should be deleted after claim deletion")

	// Second claim for the same tenant — gets a fresh cold boot (no snapshot in envtest).
	claim2 := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "overlay-claim2", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-overlay",
			WorkloadRef: "overlay-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim2))

	claim2Key := types.NamespacedName{Name: "overlay-claim2", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claim2Key, "Active", 10)

	var activeClaim2 v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claim2Key, &activeClaim2))
	instanceId2 := activeClaim2.Status.InstanceId
	require.NotEmpty(t, instanceId2)

	// Verify new Pod also has emptyDir overlay.
	var pod2 corev1.Pod
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: instanceId2, Namespace: "default"}, &pod2))
	require.Len(t, pod2.Spec.Volumes, 1)
	assert.NotNil(t, pod2.Spec.Volumes[0].EmptyDir)

	// Source is "cold" without a snapshot manager.
	assert.Equal(t, "cold", activeClaim2.Status.Source,
		"source should be cold without snapshot manager")
}

// ---------------------------------------------------------------------------
// 4. TestIntegration_DestroyWorkloadBlockedByClaim
// ---------------------------------------------------------------------------

func TestIntegration_DestroyWorkloadBlockedByClaim(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	claimReconciler := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}

	// Create workload and reconcile to Ready (adds finalizer).
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "destroy-wl", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image:   v1alpha1.WorkloadImage{Ref: "alpine:3.19"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs: 1, MemoryMb: 64, DiskGb: 1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "sleep 3600"},
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	wlKey := types.NamespacedName{Name: "destroy-wl", Namespace: "default"}
	reconcileWorkloadUntilPhase(t, wlReconciler, k8sClient, wlKey, "Ready", 5)

	// Verify workload has finalizer.
	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, wlKey, &readyWl))
	require.Contains(t, readyWl.Finalizers, finalizerName)

	// Create a claim and reconcile to Active.
	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "destroy-claim", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-destroy",
			WorkloadRef: "destroy-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	claimKey := types.NamespacedName{Name: "destroy-claim", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claimKey, "Active", 10)

	var activeClaim v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &activeClaim))
	instanceId := activeClaim.Status.InstanceId
	require.NotEmpty(t, instanceId)

	// Delete the workload (sets deletionTimestamp, but finalizer blocks actual deletion).
	require.NoError(t, k8sClient.Delete(ctx, &readyWl))

	// Reconcile the workload. The finalizer handler deletes owned pods, then
	// removes the finalizer. But the pod we care about was created by the claim
	// reconciler with the workload label, so deleteOwnedPods will find it.
	// After this reconcile, the workload should be gone because its finalizer
	// cleanup deletes all pods with that workload label.
	//
	// First, verify the workload still exists (has deletionTimestamp + finalizer).
	var markedWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, wlKey, &markedWl))
	assert.False(t, markedWl.DeletionTimestamp.IsZero(), "workload should have deletionTimestamp")
	assert.Contains(t, markedWl.Finalizers, finalizerName)

	// Reconcile the workload deletion — this deletes owned pods and removes finalizer.
	reconcileN(t, wlReconciler, wlKey, 3)

	// Verify the workload is now fully deleted.
	var deletedWl v1alpha1.BoilerhouseWorkload
	err := k8sClient.Get(ctx, wlKey, &deletedWl)
	assert.True(t, apierrors.IsNotFound(err), "workload should be deleted after finalizer cleanup")

	// Verify the Pod was also deleted by the workload finalizer.
	var deletedPod corev1.Pod
	err = k8sClient.Get(ctx, types.NamespacedName{Name: instanceId, Namespace: "default"}, &deletedPod)
	assert.True(t, apierrors.IsNotFound(err), "pod should be deleted by workload finalizer")

	// Now reconcile the claim deletion (the claim still exists with its finalizer).
	// Delete the claim.
	var latestClaim v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &latestClaim))
	require.NoError(t, k8sClient.Delete(ctx, &latestClaim))
	reconcileN(t, claimReconciler, claimKey, 5)

	// Verify claim is fully deleted.
	var deletedClaim v1alpha1.BoilerhouseClaim
	err = k8sClient.Get(ctx, claimKey, &deletedClaim)
	assert.True(t, apierrors.IsNotFound(err), "claim should be deleted")
}

// ---------------------------------------------------------------------------
// 5. TestIntegration_MultiTenantDistinctInstances
// ---------------------------------------------------------------------------

func TestIntegration_MultiTenantDistinctInstances(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlReconciler := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	claimReconciler := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}

	// Create workload and reconcile to Ready.
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "multi-wl", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image:   v1alpha1.WorkloadImage{Ref: "alpine:3.19"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs: 1, MemoryMb: 64, DiskGb: 1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "sleep 3600"},
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	wlKey := types.NamespacedName{Name: "multi-wl", Namespace: "default"}
	reconcileWorkloadUntilPhase(t, wlReconciler, k8sClient, wlKey, "Ready", 5)

	// Claim for tenant-a.
	claimA := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "multi-claim-a", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-a",
			WorkloadRef: "multi-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claimA))

	claimAKey := types.NamespacedName{Name: "multi-claim-a", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claimAKey, "Active", 10)

	var activeClaimA v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimAKey, &activeClaimA))
	instanceIdA := activeClaimA.Status.InstanceId
	require.NotEmpty(t, instanceIdA, "tenant-a claim should have instanceId")

	// Claim for tenant-b.
	claimB := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "multi-claim-b", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-b",
			WorkloadRef: "multi-wl",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, claimB))

	claimBKey := types.NamespacedName{Name: "multi-claim-b", Namespace: "default"}
	reconcileClaimUntilPhase(t, claimReconciler, k8sClient, claimBKey, "Active", 10)

	var activeClaimB v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimBKey, &activeClaimB))
	instanceIdB := activeClaimB.Status.InstanceId
	require.NotEmpty(t, instanceIdB, "tenant-b claim should have instanceId")

	// Different tenants must get different instances (different Pod names).
	assert.NotEqual(t, instanceIdA, instanceIdB,
		"two different tenants claiming the same workload should get distinct instances")

	// Verify both Pods exist.
	var podA corev1.Pod
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: instanceIdA, Namespace: "default"}, &podA))
	assert.Equal(t, "tenant-a", podA.Labels[LabelTenant])

	var podB corev1.Pod
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: instanceIdB, Namespace: "default"}, &podB))
	assert.Equal(t, "tenant-b", podB.Labels[LabelTenant])
}
