package operator

import (
	"context"
	"fmt"
	"strings"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const finalizerName = "boilerhouse.dev/cleanup"

// WorkloadReconciler reconciles BoilerhouseWorkload objects.
type WorkloadReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile handles a single reconciliation loop for a BoilerhouseWorkload.
func (r *WorkloadReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	// 1. Get the workload.
	var wl v1alpha1.BoilerhouseWorkload
	if err := r.Get(ctx, req.NamespacedName, &wl); err != nil {
		if apierrors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		return reconcile.Result{}, err
	}

	// 2. Handle deletion (finalizer cleanup).
	if !wl.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&wl, finalizerName) {
			// Clean up: delete all pods labelled for this workload.
			if err := r.deleteOwnedPods(ctx, wl.Namespace, wl.Name); err != nil {
				return reconcile.Result{}, fmt.Errorf("cleaning up pods: %w", err)
			}

			controllerutil.RemoveFinalizer(&wl, finalizerName)
			if err := r.Update(ctx, &wl); err != nil {
				return reconcile.Result{}, err
			}
		}
		return reconcile.Result{}, nil
	}

	// 3. Add finalizer if missing.
	if !controllerutil.ContainsFinalizer(&wl, finalizerName) {
		controllerutil.AddFinalizer(&wl, finalizerName)
		if err := r.Update(ctx, &wl); err != nil {
			return reconcile.Result{}, err
		}
		// Re-fetch after update to get the latest resourceVersion.
		if err := r.Get(ctx, req.NamespacedName, &wl); err != nil {
			return reconcile.Result{}, err
		}
	}

	// 4. Already Ready, spec unchanged — no-op.
	if wl.Status.Phase == "Ready" && wl.Status.ObservedGeneration == wl.Generation {
		return reconcile.Result{}, nil
	}

	// 5. Validate spec.
	if errs := validateWorkloadSpec(wl.Spec); len(errs) > 0 {
		wl.Status.Phase = "Error"
		wl.Status.Detail = strings.Join(errs, "; ")
		wl.Status.ObservedGeneration = wl.Generation
		if err := r.Status().Update(ctx, &wl); err != nil {
			return reconcile.Result{}, err
		}
		return reconcile.Result{}, nil
	}

	// 6. Valid — set Ready.
	wl.Status.Phase = "Ready"
	wl.Status.Detail = ""
	wl.Status.ObservedGeneration = wl.Generation
	if err := r.Status().Update(ctx, &wl); err != nil {
		return reconcile.Result{}, err
	}

	return reconcile.Result{}, nil
}

// validateWorkloadSpec checks that required fields are set.
func validateWorkloadSpec(spec v1alpha1.BoilerhouseWorkloadSpec) []string {
	var errs []string
	if spec.Image.Ref == "" {
		errs = append(errs, "image.ref must be set")
	}
	if spec.Resources.VCPUs <= 0 {
		errs = append(errs, "resources.vcpus must be > 0")
	}
	if spec.Resources.MemoryMb <= 0 {
		errs = append(errs, "resources.memoryMb must be > 0")
	}
	return errs
}

// deleteOwnedPods deletes all pods with label boilerhouse.dev/workload=<name>.
func (r *WorkloadReconciler) deleteOwnedPods(ctx context.Context, namespace, workloadName string) error {
	var podList corev1.PodList
	if err := r.List(ctx, &podList,
		client.InNamespace(namespace),
		client.MatchingLabels{LabelWorkload: workloadName},
	); err != nil {
		return err
	}

	for i := range podList.Items {
		if err := r.Delete(ctx, &podList.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// SetupWithManager registers the WorkloadReconciler with the controller manager.
func (r *WorkloadReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.BoilerhouseWorkload{}).
		Complete(r)
}
