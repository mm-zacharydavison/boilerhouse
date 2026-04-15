package operator

import (
	"context"
	"fmt"
	"strings"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// validTriggerTypes enumerates the allowed values for spec.type.
var validTriggerTypes = map[string]bool{
	"webhook":  true,
	"slack":    true,
	"telegram": true,
	"cron":     true,
}

// TriggerReconciler reconciles BoilerhouseTrigger objects.
type TriggerReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile handles a single reconciliation loop for a BoilerhouseTrigger.
func (r *TriggerReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	// 1. Get the trigger.
	var trigger v1alpha1.BoilerhouseTrigger
	if err := r.Get(ctx, req.NamespacedName, &trigger); err != nil {
		if apierrors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		return reconcile.Result{}, err
	}

	// 2. Handle deletion: remove finalizer and return.
	if !trigger.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&trigger, finalizerName) {
			controllerutil.RemoveFinalizer(&trigger, finalizerName)
			if err := r.Update(ctx, &trigger); err != nil {
				return reconcile.Result{}, err
			}
		}
		return reconcile.Result{}, nil
	}

	// 3. Add finalizer if missing.
	if !controllerutil.ContainsFinalizer(&trigger, finalizerName) {
		controllerutil.AddFinalizer(&trigger, finalizerName)
		if err := r.Update(ctx, &trigger); err != nil {
			return reconcile.Result{}, err
		}
		// Re-fetch after update to get the latest resourceVersion.
		if err := r.Get(ctx, req.NamespacedName, &trigger); err != nil {
			return reconcile.Result{}, err
		}
	}

	// 4. Validate trigger spec.
	if errs := validateTriggerSpec(trigger.Spec); len(errs) > 0 {
		return r.setStatus(ctx, &trigger, "Error", strings.Join(errs, "; "))
	}

	// 5. Look up the referenced BoilerhouseWorkload.
	var wl v1alpha1.BoilerhouseWorkload
	wlKey := types.NamespacedName{
		Name:      trigger.Spec.WorkloadRef,
		Namespace: trigger.Namespace,
	}
	if err := r.Get(ctx, wlKey, &wl); err != nil {
		if apierrors.IsNotFound(err) {
			detail := fmt.Sprintf("referenced workload %q not found", trigger.Spec.WorkloadRef)
			return r.setStatus(ctx, &trigger, "Error", detail)
		}
		return reconcile.Result{}, err
	}

	// 6. Valid — set Active.
	return r.setStatus(ctx, &trigger, "Active", "")
}

// setStatus updates the trigger's status phase and detail.
func (r *TriggerReconciler) setStatus(ctx context.Context, trigger *v1alpha1.BoilerhouseTrigger, phase, detail string) (reconcile.Result, error) {
	trigger.Status.Phase = phase
	trigger.Status.Detail = detail
	if err := r.Status().Update(ctx, trigger); err != nil {
		return reconcile.Result{}, err
	}
	return reconcile.Result{}, nil
}

// validateTriggerSpec checks that required fields are set and valid.
func validateTriggerSpec(spec v1alpha1.BoilerhouseTriggerSpec) []string {
	var errs []string

	if spec.WorkloadRef == "" {
		errs = append(errs, "workloadRef must be set")
	}

	if !validTriggerTypes[spec.Type] {
		errs = append(errs, fmt.Sprintf("type %q is not valid; must be one of: webhook, slack, telegram, cron", spec.Type))
	}

	if spec.Tenant != nil && spec.Tenant.From == "" {
		errs = append(errs, "tenant.from must be set when tenant is specified")
	}

	return errs
}

// SetupWithManager registers the TriggerReconciler with the controller manager.
func (r *TriggerReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.BoilerhouseTrigger{}).
		Complete(r)
}
