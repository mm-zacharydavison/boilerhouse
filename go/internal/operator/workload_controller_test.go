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

func TestWorkloadController_NewWorkloadBecomesReady(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	// Create a valid BoilerhouseWorkload.
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-workload",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1.0.0",
			Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 512,
				DiskGb:   10,
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	// Reconcile.
	req := reconcile.Request{
		NamespacedName: types.NamespacedName{
			Name:      "test-workload",
			Namespace: "default",
		},
	}
	result, err := r.Reconcile(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)

	// Fetch the updated workload.
	var updated v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, req.NamespacedName, &updated))

	assert.Equal(t, "Ready", updated.Status.Phase)
	assert.Contains(t, updated.Finalizers, "boilerhouse.dev/cleanup")
	assert.Equal(t, updated.Generation, updated.Status.ObservedGeneration)
}

func TestWorkloadController_InvalidSpecBecomesError(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	// Create a workload with missing image ref.
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "bad-workload",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1.0.0",
			Image:   v1alpha1.WorkloadImage{Ref: ""},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    0,
				MemoryMb: 0,
				DiskGb:   10,
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	req := reconcile.Request{
		NamespacedName: types.NamespacedName{
			Name:      "bad-workload",
			Namespace: "default",
		},
	}
	result, err := r.Reconcile(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)

	var updated v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, req.NamespacedName, &updated))

	assert.Equal(t, "Error", updated.Status.Phase)
	assert.NotEmpty(t, updated.Status.Detail)
}

func TestWorkloadController_DeletionCleansUp(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	// Create a valid workload and reconcile it to Ready.
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "delete-workload",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1.0.0",
			Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 256,
				DiskGb:   5,
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	req := reconcile.Request{
		NamespacedName: types.NamespacedName{
			Name:      "delete-workload",
			Namespace: "default",
		},
	}
	_, err := r.Reconcile(ctx, req)
	require.NoError(t, err)

	// Verify it's Ready with finalizer.
	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, req.NamespacedName, &readyWl))
	require.Equal(t, "Ready", readyWl.Status.Phase)
	require.Contains(t, readyWl.Finalizers, "boilerhouse.dev/cleanup")

	// Create a pod that belongs to this workload (simulating a managed pod).
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "managed-pod-1",
			Namespace: "default",
			Labels: map[string]string{
				"boilerhouse.dev/workload": "delete-workload",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "main",
					Image: "nginx:latest",
				},
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, pod))

	// Delete the workload (this sets deletionTimestamp but the finalizer prevents removal).
	require.NoError(t, k8sClient.Delete(ctx, &readyWl))

	// Reconcile the deletion.
	result, err := r.Reconcile(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)

	// The workload should be fully deleted now (finalizer removed).
	var deletedWl v1alpha1.BoilerhouseWorkload
	err = k8sClient.Get(ctx, req.NamespacedName, &deletedWl)
	assert.Error(t, err, "workload should be deleted after finalizer removal")

	// The managed pod should be deleted.
	var deletedPod corev1.Pod
	err = k8sClient.Get(ctx, types.NamespacedName{Name: "managed-pod-1", Namespace: "default"}, &deletedPod)
	assert.Error(t, err, "managed pod should be deleted during cleanup")
}

func TestWorkloadController_NoOpWhenUnchanged(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "stable-workload",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1.0.0",
			Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 256,
				DiskGb:   5,
			},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))

	req := reconcile.Request{
		NamespacedName: types.NamespacedName{
			Name:      "stable-workload",
			Namespace: "default",
		},
	}

	// First reconcile sets it to Ready.
	_, err := r.Reconcile(ctx, req)
	require.NoError(t, err)

	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, req.NamespacedName, &readyWl))
	require.Equal(t, "Ready", readyWl.Status.Phase)
	gen := readyWl.Status.ObservedGeneration

	// Second reconcile should be a no-op (observedGeneration matches).
	result, err := r.Reconcile(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)

	// Verify nothing changed.
	var unchanged v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, req.NamespacedName, &unchanged))
	assert.Equal(t, gen, unchanged.Status.ObservedGeneration)
	assert.Equal(t, "Ready", unchanged.Status.Phase)
}
