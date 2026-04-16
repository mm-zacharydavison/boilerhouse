package operator

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

func TestTriggerController_ValidTriggerBecomesActive(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// First create a workload and reconcile it to Ready so the trigger can reference it.
	wlReconciler := &WorkloadReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "trigger-target",
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

	wlReq := reconcile.Request{
		NamespacedName: types.NamespacedName{
			Name:      "trigger-target",
			Namespace: "default",
		},
	}
	for i := 0; i < 5; i++ {
		_, err := wlReconciler.Reconcile(ctx, wlReq)
		require.NoError(t, err)
	}

	// Verify workload is Ready.
	var readyWl v1alpha1.BoilerhouseWorkload
	require.NoError(t, k8sClient.Get(ctx, wlReq.NamespacedName, &readyWl))
	require.Equal(t, "Ready", readyWl.Status.Phase)

	// Now create a valid trigger referencing the workload.
	r := &TriggerReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-trigger",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "webhook",
			WorkloadRef: "trigger-target",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, trigger))

	req := reconcile.Request{
		NamespacedName: types.NamespacedName{
			Name:      "test-trigger",
			Namespace: "default",
		},
	}

	// First reconcile adds finalizer.
	result, err := r.Reconcile(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)

	// Fetch the updated trigger.
	var updated v1alpha1.BoilerhouseTrigger
	require.NoError(t, k8sClient.Get(ctx, req.NamespacedName, &updated))

	assert.Equal(t, "Active", updated.Status.Phase)
	assert.Empty(t, updated.Status.Detail)
	assert.Contains(t, updated.Finalizers, "boilerhouse.dev/cleanup")
}

func TestTriggerController_InvalidTypeBecomesError(t *testing.T) {
	// The CRD enum validation prevents creating a trigger with an invalid type
	// via the API server. Test the validation logic directly to ensure defense-in-depth.
	errs := validateTriggerSpec(v1alpha1.BoilerhouseTriggerSpec{
		Type:        "invalid",
		WorkloadRef: "some-workload",
	})
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0], "not valid")
	assert.Contains(t, errs[0], "invalid")

	// Also verify that valid types pass validation.
	for _, validType := range []string{"webhook", "slack", "telegram", "cron"} {
		errs := validateTriggerSpec(v1alpha1.BoilerhouseTriggerSpec{
			Type:        validType,
			WorkloadRef: "some-workload",
		})
		assert.Empty(t, errs, "expected no errors for valid type %q", validType)
	}
}

func TestTriggerController_MissingWorkloadBecomesError(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	r := &TriggerReconciler{
		Client: k8sClient,
		Scheme: k8sClient.Scheme(),
	}

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "orphan-trigger",
			Namespace: "default",
		},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "webhook",
			WorkloadRef: "nonexistent-workload",
		},
	}
	require.NoError(t, k8sClient.Create(ctx, trigger))

	req := reconcile.Request{
		NamespacedName: types.NamespacedName{
			Name:      "orphan-trigger",
			Namespace: "default",
		},
	}

	result, err := r.Reconcile(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, reconcile.Result{}, result)

	var updated v1alpha1.BoilerhouseTrigger
	require.NoError(t, k8sClient.Get(ctx, req.NamespacedName, &updated))

	assert.Equal(t, "Error", updated.Status.Phase)
	assert.Contains(t, updated.Status.Detail, "nonexistent-workload")
	assert.Contains(t, updated.Status.Detail, "not found")
}
