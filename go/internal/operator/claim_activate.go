package operator

import (
	"context"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// activateClaim sets the claim to Active with the given Pod info and source.
// Refuses to activate if the Pod hasn't been assigned an IP yet — stamps the
// provenance (source) + tenant pod id on the claim, leaves Phase as Pending,
// and requeues so the next reconcile sees the populated PodIP. Preserving the
// source across requeues means a claim coldBoot'd on reconcile N still
// reports source=cold when it finally activates on reconcile N+1.
func (r *ClaimReconciler) activateClaim(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, pod *corev1.Pod, source string) (reconcile.Result, error) {
	podIP := pod.Status.PodIP
	if podIP == "" {
		// Stash provenance so we don't "forget" why we picked this pod on
		// the next reconcile (which would otherwise see an existing tenant
		// pod and attribute the claim to source=existing).
		if claim.Status.Source != source || claim.Status.InstanceId != pod.Name {
			claim.Status.Source = source
			claim.Status.InstanceId = pod.Name
			if err := r.Status().Update(ctx, claim); err != nil {
				return reconcile.Result{}, err
			}
		}
		return reconcile.Result{RequeueAfter: 1 * time.Second}, nil
	}
	// Preserve the original source set during coldBoot / claimFromPool if one
	// exists — we only overwrite if the incoming source is stronger than
	// "existing" (i.e. the handler knows better than the fallback path).
	if source == "existing" && claim.Status.Source != "" && claim.Status.Source != "existing" {
		source = claim.Status.Source
	}
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

// handleActive implements idle monitoring for active claims.
func (r *ClaimReconciler) handleActive(ctx context.Context, claim *v1alpha1.BoilerhouseClaim) (reconcile.Result, error) {
	// Check that the backing pod still exists. If it was deleted out from
	// under us (manual kubectl delete, node drain, crash), the claim is
	// pointing at a dead endpoint — transition to Released so the next
	// trigger event can create a fresh claim from scratch.
	if claim.Status.InstanceId != "" {
		var pod corev1.Pod
		err := r.Get(ctx, types.NamespacedName{Name: claim.Status.InstanceId, Namespace: claim.Namespace}, &pod)
		if apierrors.IsNotFound(err) {
			claim.Status.Phase = "Released"
			claim.Status.Detail = "backing pod no longer exists"
			claim.Status.Endpoint = nil
			if updateErr := r.Status().Update(ctx, claim); updateErr != nil {
				return reconcile.Result{}, updateErr
			}
			return reconcile.Result{}, nil
		}
	}

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
