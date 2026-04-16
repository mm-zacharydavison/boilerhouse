package operator

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// reconcileWorkload calls Reconcile multiple times to handle the early-return pattern.
func reconcileWorkload(t *testing.T, r *WorkloadReconciler, key types.NamespacedName, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		_, err := r.Reconcile(t.Context(), reconcile.Request{NamespacedName: key})
		require.NoError(t, err)
	}
}

func TestWorkloadController_NewWorkloadBecomesReady(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "test-workload", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 512, DiskGb: 10},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	key := types.NamespacedName{Name: "test-workload", Namespace: "default"}
	reconcileWorkload(t, r, key, 5)

	var updated v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, key, &updated))
	assert.Equal(t, "Ready", updated.Status.Phase)
	assert.Contains(t, updated.Finalizers, finalizerName)
}

func TestWorkloadController_InvalidSpecBecomesError(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "bad-workload", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{},
			Resources: v1alpha1.WorkloadResources{VCPUs: 0, MemoryMb: 0, DiskGb: 10},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	key := types.NamespacedName{Name: "bad-workload", Namespace: "default"}
	reconcileWorkload(t, r, key, 5)

	var updated v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, key, &updated))
	assert.Equal(t, "Error", updated.Status.Phase)
	assert.NotEmpty(t, updated.Status.Detail)
}

func TestWorkloadController_DeletionCleansUp(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "delete-workload", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	key := types.NamespacedName{Name: "delete-workload", Namespace: "default"}
	reconcileWorkload(t, r, key, 5)

	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, key, &readyWl))
	require.Equal(t, "Ready", readyWl.Status.Phase)

	// Create a managed pod.
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "managed-pod-1", Namespace: "default",
			Labels: map[string]string{LabelWorkload: "delete-workload"},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "main", Image: "nginx:latest"}},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, pod))

	// Delete the workload.
	require.NoError(t, k8sClient.Delete(ctx, &readyWl))
	reconcileWorkload(t, r, key, 3)

	// Workload should be fully deleted.
	var deletedWl v1alpha1.BoilerhouseWorkload
	err := k8sClient.Get(ctx, key, &deletedWl)
	assert.Error(t, err, "workload should be deleted")

	// Managed pod should be deleted.
	var deletedPod corev1.Pod
	err = k8sClient.Get(ctx, types.NamespacedName{Name: "managed-pod-1", Namespace: "default"}, &deletedPod)
	assert.Error(t, err, "pod should be deleted")
}

func TestWorkloadController_NoOpWhenUnchanged(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "stable-workload", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	key := types.NamespacedName{Name: "stable-workload", Namespace: "default"}
	reconcileWorkload(t, r, key, 5)

	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, key, &readyWl))
	require.Equal(t, "Ready", readyWl.Status.Phase)

	// Another reconcile should be a no-op.
	result, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)
}
