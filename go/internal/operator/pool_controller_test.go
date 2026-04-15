package operator

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

func TestPoolController_CreatesPoolPods(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Create a workload and reconcile it to Ready.
	wlReconciler := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "pool-wl",
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

	_, err := wlReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "pool-wl", Namespace: "default"},
	})
	require.NoError(t, err)

	// Verify workload is Ready.
	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: "pool-wl", Namespace: "default"}, &readyWl))
	require.Equal(t, "Ready", readyWl.Status.Phase)

	// Create a Pool with size=2.
	pool := &v1alpha1.BoilerhousePool{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-pool",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhousePoolSpec{
			WorkloadRef: "pool-wl",
			Size:        2,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, pool))

	// Reconcile the pool.
	poolReconciler := &PoolReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}
	// First reconcile adds finalizer.
	result, err := poolReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "test-pool", Namespace: "default"},
	})
	require.NoError(t, err)
	assert.NotZero(t, result.RequeueAfter)

	// Verify 2 Pods were created with pool-status=warming.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelWorkload: "pool-wl"},
	))

	warmingPods := 0
	for _, pod := range podList.Items {
		if pod.Labels[LabelPoolStatus] == "warming" {
			warmingPods++
			// Verify label structure.
			assert.Equal(t, "pool-wl", pod.Labels[LabelWorkload])
			assert.Equal(t, "true", pod.Labels[LabelManaged])
		}
	}
	assert.Equal(t, 2, warmingPods)

	// Verify pool status.
	var updatedPool v1alpha1.BoilerhousePool
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: "test-pool", Namespace: "default"}, &updatedPool))
	assert.Equal(t, 2, updatedPool.Status.Warming)
	assert.Equal(t, 0, updatedPool.Status.Ready)
	assert.Equal(t, "Degraded", updatedPool.Status.Phase)
	assert.Contains(t, updatedPool.Finalizers, finalizerName)
}

func TestPoolController_RelabelsReadyPods(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Create and reconcile a Ready workload.
	wlReconciler := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "relabel-wl",
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
	_, err := wlReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "relabel-wl", Namespace: "default"},
	})
	require.NoError(t, err)

	// Create a pool with size=1.
	pool := &v1alpha1.BoilerhousePool{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "relabel-pool",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhousePoolSpec{
			WorkloadRef: "relabel-wl",
			Size:        1,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, pool))

	poolReconciler := &PoolReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	// First reconcile: creates the warming pod.
	_, err = poolReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "relabel-pool", Namespace: "default"},
	})
	require.NoError(t, err)

	// Find the warming pod.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelWorkload: "relabel-wl", LabelPoolStatus: "warming"},
	))
	require.Len(t, podList.Items, 1)

	// Patch the pod to simulate Running phase with ContainersReady condition.
	pod := &podList.Items[0]
	pod.Status.Phase = corev1.PodRunning
	pod.Status.Conditions = []corev1.PodCondition{
		{
			Type:   corev1.ContainersReady,
			Status: corev1.ConditionTrue,
		},
	}
	require.NoError(t, k8sClient.Status().Update(ctx, pod))

	// Second reconcile: should relabel warming -> ready.
	_, err = poolReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "relabel-pool", Namespace: "default"},
	})
	require.NoError(t, err)

	// Verify the pod is now labelled ready.
	var updatedPod corev1.Pod
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: pod.Name, Namespace: "default"}, &updatedPod))
	assert.Equal(t, "ready", updatedPod.Labels[LabelPoolStatus])

	// Verify pool status reflects ready=1.
	var updatedPool v1alpha1.BoilerhousePool
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: "relabel-pool", Namespace: "default"}, &updatedPool))
	assert.Equal(t, 1, updatedPool.Status.Ready)
	assert.Equal(t, 0, updatedPool.Status.Warming)
	assert.Equal(t, "Healthy", updatedPool.Status.Phase)
}

func TestPoolController_RespectsMaxFillConcurrency(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Create and reconcile a Ready workload.
	wlReconciler := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "concurrency-wl",
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
	_, err := wlReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "concurrency-wl", Namespace: "default"},
	})
	require.NoError(t, err)

	// Create a pool with size=5, maxFillConcurrency=2.
	maxFill := 2
	pool := &v1alpha1.BoilerhousePool{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "concurrency-pool",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhousePoolSpec{
			WorkloadRef:        "concurrency-wl",
			Size:               5,
			MaxFillConcurrency: &maxFill,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, pool))

	poolReconciler := &PoolReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	// First reconcile: should create only 2 pods (maxFillConcurrency), not 5.
	_, err = poolReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "concurrency-pool", Namespace: "default"},
	})
	require.NoError(t, err)

	// Verify only 2 Pods exist.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelWorkload: "concurrency-wl"},
	))

	poolPods := 0
	for _, pod := range podList.Items {
		if _, ok := pod.Labels[LabelPoolStatus]; ok {
			poolPods++
		}
	}
	assert.Equal(t, 2, poolPods, "should only create maxFillConcurrency pods, not fill entire gap")

	// Verify pool status.
	var updatedPool v1alpha1.BoilerhousePool
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: "concurrency-pool", Namespace: "default"}, &updatedPool))
	assert.Equal(t, 2, updatedPool.Status.Warming)
	assert.Equal(t, "Degraded", updatedPool.Status.Phase)
}

func TestPoolController_ErrorWhenWorkloadNotFound(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Create a pool referencing a non-existent workload.
	pool := &v1alpha1.BoilerhousePool{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "orphan-pool",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhousePoolSpec{
			WorkloadRef: "does-not-exist",
			Size:        1,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, pool))

	poolReconciler := &PoolReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	_, err := poolReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "orphan-pool", Namespace: "default"},
	})
	require.NoError(t, err)

	// Verify pool status phase=Error.
	var updatedPool v1alpha1.BoilerhousePool
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: "orphan-pool", Namespace: "default"}, &updatedPool))
	assert.Equal(t, "Error", updatedPool.Status.Phase)
}

func TestPoolController_DeletionCleansUpPods(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Create and reconcile a Ready workload.
	wlReconciler := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "delete-pool-wl",
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
	_, err := wlReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "delete-pool-wl", Namespace: "default"},
	})
	require.NoError(t, err)

	// Create a pool with size=2.
	pool := &v1alpha1.BoilerhousePool{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "delete-pool",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhousePoolSpec{
			WorkloadRef: "delete-pool-wl",
			Size:        2,
		},
	}
	require.NoError(t, k8sClient.Create(ctx, pool))

	poolReconciler := &PoolReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	// Reconcile to create pool Pods.
	_, err = poolReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "delete-pool", Namespace: "default"},
	})
	require.NoError(t, err)

	// Verify Pods exist.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelWorkload: "delete-pool-wl"},
	))
	poolPodCount := 0
	for _, pod := range podList.Items {
		if _, ok := pod.Labels[LabelPoolStatus]; ok {
			poolPodCount++
		}
	}
	require.Equal(t, 2, poolPodCount)

	// Delete the pool (sets deletionTimestamp; finalizer prevents removal).
	var latestPool v1alpha1.BoilerhousePool
	require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{Name: "delete-pool", Namespace: "default"}, &latestPool))
	require.NoError(t, k8sClient.Delete(ctx, &latestPool))

	// Reconcile the deletion.
	result, err := poolReconciler.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "delete-pool", Namespace: "default"},
	})
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)

	// Pool should be fully deleted (finalizer removed).
	var deletedPool v1alpha1.BoilerhousePool
	err = k8sClient.Get(ctx, types.NamespacedName{Name: "delete-pool", Namespace: "default"}, &deletedPool)
	assert.Error(t, err, "pool should be deleted after finalizer removal")

	// All pool pods should be deleted.
	var remainingPods corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &remainingPods,
		client.InNamespace("default"),
		client.MatchingLabels{LabelWorkload: "delete-pool-wl"},
	))
	remainingPoolPods := 0
	for _, pod := range remainingPods.Items {
		if _, ok := pod.Labels[LabelPoolStatus]; ok {
			remainingPoolPods++
		}
	}
	assert.Equal(t, 0, remainingPoolPods, "all pool pods should be deleted during cleanup")
}
