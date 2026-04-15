package operator

import (
	"context"
	"fmt"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const (
	annotationLastActivity = "boilerhouse.dev/last-activity"
	idleCheckInterval      = 30 * time.Second
)

// ClaimReconciler reconciles BoilerhouseClaim objects.
type ClaimReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile handles a single reconciliation loop for a BoilerhouseClaim.
func (r *ClaimReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	// 1. Get the claim.
	var claim v1alpha1.BoilerhouseClaim
	if err := r.Get(ctx, req.NamespacedName, &claim); err != nil {
		if apierrors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		return reconcile.Result{}, err
	}

	// 2. Handle deletion.
	if !claim.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, &claim)
	}

	// 3. Route by phase.
	switch claim.Status.Phase {
	case "Active":
		return r.handleActive(ctx, &claim)
	default:
		// Empty, Pending, or any other non-active phase: handle as new claim.
		return r.handleNewClaim(ctx, req, &claim)
	}
}

// handleNewClaim processes a claim that is not yet Active (empty or Pending phase).
func (r *ClaimReconciler) handleNewClaim(ctx context.Context, req reconcile.Request, claim *v1alpha1.BoilerhouseClaim) (reconcile.Result, error) {
	// Add finalizer if missing.
	if !controllerutil.ContainsFinalizer(claim, finalizerName) {
		controllerutil.AddFinalizer(claim, finalizerName)
		if err := r.Update(ctx, claim); err != nil {
			return reconcile.Result{}, err
		}
		// Re-fetch after update.
		if err := r.Get(ctx, req.NamespacedName, claim); err != nil {
			return reconcile.Result{}, err
		}
	}

	// Set phase to Pending if not already.
	if claim.Status.Phase != "Pending" {
		claim.Status.Phase = "Pending"
		if err := r.Status().Update(ctx, claim); err != nil {
			return reconcile.Result{}, err
		}
	}

	// Look up the referenced workload.
	var wl v1alpha1.BoilerhouseWorkload
	wlKey := types.NamespacedName{Name: claim.Spec.WorkloadRef, Namespace: claim.Namespace}
	if err := r.Get(ctx, wlKey, &wl); err != nil {
		if apierrors.IsNotFound(err) {
			return r.setClaimError(ctx, claim, "workload not found")
		}
		return reconcile.Result{}, err
	}
	if wl.Status.Phase != "Ready" {
		return r.setClaimError(ctx, claim, "workload not ready")
	}

	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef
	ns := claim.Namespace

	// Check for existing Pod with tenant label.
	existingPod, err := r.findTenantPod(ctx, ns, tenantId, workloadRef)
	if err != nil {
		return reconcile.Result{}, err
	}
	if existingPod != nil && existingPod.Status.Phase == corev1.PodRunning {
		return r.activateClaim(ctx, claim, existingPod, "existing")
	}

	// Check for a pool Pod.
	poolPod, err := r.findPoolPod(ctx, ns, workloadRef)
	if err != nil {
		return reconcile.Result{}, err
	}
	if poolPod != nil {
		return r.claimFromPool(ctx, claim, poolPod, &wl)
	}

	// Cold boot.
	return r.coldBoot(ctx, claim, &wl)
}

// findTenantPod finds a Pod with the given tenant and workload labels.
func (r *ClaimReconciler) findTenantPod(ctx context.Context, ns, tenantId, workloadRef string) (*corev1.Pod, error) {
	var podList corev1.PodList
	if err := r.List(ctx, &podList,
		client.InNamespace(ns),
		client.MatchingLabels{
			LabelTenant:  tenantId,
			LabelWorkload: workloadRef,
		},
	); err != nil {
		return nil, err
	}
	if len(podList.Items) == 0 {
		return nil, nil
	}
	return &podList.Items[0], nil
}

// findPoolPod finds a ready pool Pod for the given workload.
func (r *ClaimReconciler) findPoolPod(ctx context.Context, ns, workloadRef string) (*corev1.Pod, error) {
	var podList corev1.PodList
	if err := r.List(ctx, &podList,
		client.InNamespace(ns),
		client.MatchingLabels{
			LabelWorkload:   workloadRef,
			LabelPoolStatus: "ready",
		},
	); err != nil {
		return nil, err
	}
	if len(podList.Items) == 0 {
		return nil, nil
	}
	return &podList.Items[0], nil
}

// claimFromPool acquires a pool Pod for a tenant.
func (r *ClaimReconciler) claimFromPool(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, poolPod *corev1.Pod, wl *v1alpha1.BoilerhouseWorkload) (reconcile.Result, error) {
	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef
	ns := claim.Namespace

	pvcExists := r.pvcExists(ctx, ns, tenantId, workloadRef)

	if pvcExists {
		// Tenant has existing data: delete pool Pod, create new Pod with PVC.
		if err := r.Delete(ctx, poolPod); err != nil && !apierrors.IsNotFound(err) {
			return reconcile.Result{}, fmt.Errorf("deleting pool pod for pvc replacement: %w", err)
		}

		pod, err := r.createTenantPod(ctx, claim, wl)
		if err != nil {
			return reconcile.Result{}, err
		}
		return r.activateClaim(ctx, claim, pod, "pool+data")
	}

	// No PVC: relabel the pool Pod.
	poolPod.Labels[LabelTenant] = tenantId
	poolPod.Labels[LabelPoolStatus] = "acquired"
	if err := r.Update(ctx, poolPod); err != nil {
		return reconcile.Result{}, fmt.Errorf("relabeling pool pod: %w", err)
	}
	return r.activateClaim(ctx, claim, poolPod, "pool")
}

// coldBoot creates a new Pod from scratch for a tenant.
func (r *ClaimReconciler) coldBoot(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, wl *v1alpha1.BoilerhouseWorkload) (reconcile.Result, error) {
	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef
	ns := claim.Namespace

	pvcExists := r.pvcExists(ctx, ns, tenantId, workloadRef)

	pod, err := r.createTenantPod(ctx, claim, wl)
	if err != nil {
		return reconcile.Result{}, err
	}

	source := "cold"
	if pvcExists {
		source = "cold+data"
	}
	return r.activateClaim(ctx, claim, pod, source)
}

// createTenantPod translates a workload spec and creates the Pod.
func (r *ClaimReconciler) createTenantPod(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, wl *v1alpha1.BoilerhouseWorkload) (*corev1.Pod, error) {
	suffix := randomSuffix()
	instanceId := fmt.Sprintf("%s-%s-%s", claim.Spec.WorkloadRef, claim.Spec.TenantId, suffix)

	result, err := Translate(wl.Spec, TranslateOpts{
		InstanceId:   instanceId,
		WorkloadName: claim.Spec.WorkloadRef,
		TenantId:     claim.Spec.TenantId,
		Namespace:    claim.Namespace,
	})
	if err != nil {
		return nil, fmt.Errorf("translating workload: %w", err)
	}

	if err := r.Create(ctx, result.Pod); err != nil {
		return nil, fmt.Errorf("creating tenant pod: %w", err)
	}

	return result.Pod, nil
}

// activateClaim sets the claim to Active with the given Pod info and source.
func (r *ClaimReconciler) activateClaim(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, pod *corev1.Pod, source string) (reconcile.Result, error) {
	podIP := pod.Status.PodIP
	port := 0
	if len(pod.Spec.Containers) > 0 && len(pod.Spec.Containers[0].Ports) > 0 {
		port = int(pod.Spec.Containers[0].Ports[0].ContainerPort)
	}

	now := metav1.Now()
	claim.Status.Phase = "Active"
	claim.Status.InstanceId = pod.Name
	claim.Status.Endpoint = &v1alpha1.ClaimEndpoint{
		Host: podIP,
		Port: port,
	}
	claim.Status.Source = source
	claim.Status.ClaimedAt = &now
	claim.Status.Detail = ""

	if err := r.Status().Update(ctx, claim); err != nil {
		return reconcile.Result{}, err
	}

	return reconcile.Result{RequeueAfter: idleCheckInterval}, nil
}

// setClaimError sets the claim phase to Error with a detail message.
func (r *ClaimReconciler) setClaimError(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, detail string) (reconcile.Result, error) {
	claim.Status.Phase = "Error"
	claim.Status.Detail = detail
	if err := r.Status().Update(ctx, claim); err != nil {
		return reconcile.Result{}, err
	}
	return reconcile.Result{}, nil
}

// handleActive implements idle monitoring for active claims.
func (r *ClaimReconciler) handleActive(ctx context.Context, claim *v1alpha1.BoilerhouseClaim) (reconcile.Result, error) {
	// Look up the workload idle config.
	var wl v1alpha1.BoilerhouseWorkload
	wlKey := types.NamespacedName{Name: claim.Spec.WorkloadRef, Namespace: claim.Namespace}
	if err := r.Get(ctx, wlKey, &wl); err != nil {
		if apierrors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		return reconcile.Result{}, err
	}

	if wl.Spec.Idle == nil || wl.Spec.Idle.TimeoutSeconds <= 0 {
		// No idle monitoring configured.
		return reconcile.Result{}, nil
	}

	timeout := time.Duration(wl.Spec.Idle.TimeoutSeconds) * time.Second
	action := wl.Spec.Idle.Action
	if action == "" {
		action = "hibernate"
	}

	// Read last-activity annotation.
	lastActivityStr := ""
	if claim.Annotations != nil {
		lastActivityStr = claim.Annotations[annotationLastActivity]
	}

	var lastActivity time.Time
	if lastActivityStr != "" {
		parsed, err := time.Parse(time.RFC3339, lastActivityStr)
		if err == nil {
			lastActivity = parsed
		}
	}

	// If no last-activity annotation, use claimedAt.
	if lastActivity.IsZero() && claim.Status.ClaimedAt != nil {
		lastActivity = claim.Status.ClaimedAt.Time
	}
	if lastActivity.IsZero() {
		// No reference time, requeue.
		return reconcile.Result{RequeueAfter: idleCheckInterval}, nil
	}

	elapsed := time.Since(lastActivity)
	if elapsed >= timeout {
		return r.releaseClaim(ctx, claim, action)
	}

	remaining := timeout - elapsed
	return reconcile.Result{RequeueAfter: remaining}, nil
}

// releaseClaim deletes the Pod (and optionally PVC) and sets phase=Released.
func (r *ClaimReconciler) releaseClaim(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, action string) (reconcile.Result, error) {
	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef
	ns := claim.Namespace

	// Delete the Pod.
	pod, err := r.findTenantPod(ctx, ns, tenantId, workloadRef)
	if err != nil {
		return reconcile.Result{}, err
	}
	if pod != nil {
		if err := r.Delete(ctx, pod); err != nil && !apierrors.IsNotFound(err) {
			return reconcile.Result{}, fmt.Errorf("deleting pod on release: %w", err)
		}
	}

	// If action=destroy, also delete the PVC.
	if action == "destroy" {
		pvcName := fmt.Sprintf("overlay-%s-%s", tenantId, workloadRef)
		var pvc corev1.PersistentVolumeClaim
		if err := r.Get(ctx, types.NamespacedName{Name: pvcName, Namespace: ns}, &pvc); err == nil {
			if err := r.Delete(ctx, &pvc); err != nil && !apierrors.IsNotFound(err) {
				return reconcile.Result{}, fmt.Errorf("deleting pvc on release: %w", err)
			}
		}
	}

	claim.Status.Phase = "Released"
	claim.Status.Detail = fmt.Sprintf("idle timeout (%s)", action)
	if err := r.Status().Update(ctx, claim); err != nil {
		return reconcile.Result{}, err
	}

	return reconcile.Result{}, nil
}

// handleDeletion handles the cleanup when a claim is being deleted.
func (r *ClaimReconciler) handleDeletion(ctx context.Context, claim *v1alpha1.BoilerhouseClaim) (reconcile.Result, error) {
	if !controllerutil.ContainsFinalizer(claim, finalizerName) {
		return reconcile.Result{}, nil
	}

	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef
	ns := claim.Namespace

	// Delete the tenant's Pod.
	pod, err := r.findTenantPod(ctx, ns, tenantId, workloadRef)
	if err != nil {
		return reconcile.Result{}, err
	}
	if pod != nil {
		if err := r.Delete(ctx, pod); err != nil && !apierrors.IsNotFound(err) {
			return reconcile.Result{}, fmt.Errorf("deleting pod on claim deletion: %w", err)
		}
	}

	// Look up the workload idle action to decide about PVC.
	var wl v1alpha1.BoilerhouseWorkload
	wlKey := types.NamespacedName{Name: workloadRef, Namespace: ns}
	if err := r.Get(ctx, wlKey, &wl); err == nil {
		if wl.Spec.Idle != nil && wl.Spec.Idle.Action == "destroy" {
			pvcName := fmt.Sprintf("overlay-%s-%s", tenantId, workloadRef)
			var pvc corev1.PersistentVolumeClaim
			if err := r.Get(ctx, types.NamespacedName{Name: pvcName, Namespace: ns}, &pvc); err == nil {
				if err := r.Delete(ctx, &pvc); err != nil && !apierrors.IsNotFound(err) {
					return reconcile.Result{}, fmt.Errorf("deleting pvc on claim deletion: %w", err)
				}
			}
		}
	}

	// Remove finalizer.
	controllerutil.RemoveFinalizer(claim, finalizerName)
	if err := r.Update(ctx, claim); err != nil {
		return reconcile.Result{}, err
	}

	return reconcile.Result{}, nil
}

// pvcExists checks if a PVC exists for the given tenant and workload.
func (r *ClaimReconciler) pvcExists(ctx context.Context, ns, tenantId, workloadRef string) bool {
	pvcName := fmt.Sprintf("overlay-%s-%s", tenantId, workloadRef)
	var pvc corev1.PersistentVolumeClaim
	err := r.Get(ctx, types.NamespacedName{Name: pvcName, Namespace: ns}, &pvc)
	return err == nil
}

// SetupWithManager registers the ClaimReconciler with the controller manager.
func (r *ClaimReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.BoilerhouseClaim{}).
		Complete(r)
}
