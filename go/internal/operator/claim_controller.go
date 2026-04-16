package operator

import (
	"context"
	"fmt"
	"time"

	"github.com/zdavison/boilerhouse/go/internal/envoy"

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
	Scheme    *runtime.Scheme
	Snapshots *SnapshotManager
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
	// Add finalizer if missing — return early to let next reconcile handle the rest.
	if !controllerutil.ContainsFinalizer(claim, finalizerName) {
		controllerutil.AddFinalizer(claim, finalizerName)
		if err := r.Update(ctx, claim); err != nil {
			return reconcile.Result{}, err
		}
		return reconcile.Result{Requeue: true}, nil
	}

	// Set phase to Pending if not already — return early.
	if claim.Status.Phase != "Pending" {
		claim.Status.Phase = "Pending"
		if err := r.Status().Update(ctx, claim); err != nil {
			return reconcile.Result{}, err
		}
		return reconcile.Result{Requeue: true}, nil
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
// If the tenant has a stored snapshot, the pool Pod is relabeled and the
// snapshot is injected via tar extract; otherwise just relabel.
func (r *ClaimReconciler) claimFromPool(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, poolPod *corev1.Pod, wl *v1alpha1.BoilerhouseWorkload) (reconcile.Result, error) {
	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef

	// Relabel the pool Pod for this tenant.
	poolPod.Labels[LabelTenant] = tenantId
	poolPod.Labels[LabelPoolStatus] = "acquired"
	if err := r.Update(ctx, poolPod); err != nil {
		return reconcile.Result{}, fmt.Errorf("relabeling pool pod: %w", err)
	}

	// Check for a stored snapshot and inject it if present.
	if r.Snapshots != nil {
		hasSnap, err := r.Snapshots.HasSnapshot(ctx, tenantId, workloadRef)
		if err != nil {
			// Log but don't fail the claim — the Pod is still usable.
			ctrl.LoggerFrom(ctx).Error(err, "checking for snapshot", "tenant", tenantId, "workload", workloadRef)
		} else if hasSnap {
			if err := r.Snapshots.InjectSnapshot(ctx, poolPod.Name, tenantId, workloadRef); err != nil {
				ctrl.LoggerFrom(ctx).Error(err, "injecting snapshot", "tenant", tenantId, "workload", workloadRef)
			} else {
				return r.activateClaim(ctx, claim, poolPod, "pool+data")
			}
		}
	}

	return r.activateClaim(ctx, claim, poolPod, "pool")
}

// coldBoot creates a new Pod from scratch for a tenant.
// If a snapshot exists, it will be injected once the Pod is running.
// Note: snapshot injection requires the Pod to be running, so for cold boots
// the injection happens on a subsequent reconcile when the Pod is ready.
func (r *ClaimReconciler) coldBoot(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, wl *v1alpha1.BoilerhouseWorkload) (reconcile.Result, error) {
	pod, err := r.createTenantPod(ctx, claim, wl)
	if err != nil {
		return reconcile.Result{}, err
	}

	return r.activateClaim(ctx, claim, pod, "cold")
}

// createTenantPod translates a workload spec and creates the Pod.
// If the workload has network credentials, it resolves them, generates Envoy
// config and TLS certs, creates a ConfigMap, and injects the sidecar.
func (r *ClaimReconciler) createTenantPod(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, wl *v1alpha1.BoilerhouseWorkload) (*corev1.Pod, error) {
	suffix := randomSuffix()
	instanceId := fmt.Sprintf("%s-%s-%s", claim.Spec.WorkloadRef, claim.Spec.TenantId, suffix)

	opts := TranslateOpts{
		InstanceId:   instanceId,
		WorkloadName: claim.Spec.WorkloadRef,
		TenantId:     claim.Spec.TenantId,
		Namespace:    claim.Namespace,
	}

	// Resolve credentials and build proxy config if workload has credentials.
	if wl.Spec.Network != nil && len(wl.Spec.Network.Credentials) > 0 {
		proxyConfig, err := r.buildProxyConfig(ctx, claim, wl)
		if err != nil {
			return nil, fmt.Errorf("building proxy config: %w", err)
		}
		opts.ProxyConfig = proxyConfig
	}

	result, err := Translate(wl.Spec, opts)
	if err != nil {
		return nil, fmt.Errorf("translating workload: %w", err)
	}

	// Create ConfigMap before Pod if sidecar is injected.
	if result.ConfigMap != nil {
		if err := r.Create(ctx, result.ConfigMap); err != nil {
			return nil, fmt.Errorf("creating proxy configmap: %w", err)
		}
	}

	if err := r.Create(ctx, result.Pod); err != nil {
		return nil, fmt.Errorf("creating tenant pod: %w", err)
	}

	return result.Pod, nil
}

// buildProxyConfig resolves credentials, generates Envoy YAML and TLS certs.
func (r *ClaimReconciler) buildProxyConfig(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, wl *v1alpha1.BoilerhouseWorkload) (*ProxyConfig, error) {
	resolved, err := ResolveCredentials(ctx, r.Client, claim.Namespace, claim.Spec.TenantId, wl.Spec.Network.Credentials)
	if err != nil {
		return nil, fmt.Errorf("resolving credentials: %w", err)
	}

	// Collect domains for TLS.
	var domains []string
	for _, rc := range resolved {
		domains = append(domains, rc.Domain)
	}

	// Generate TLS material.
	tlsMaterial, err := envoy.GenerateTLS(domains)
	if err != nil {
		return nil, fmt.Errorf("generating TLS material: %w", err)
	}

	// Generate Envoy config YAML.
	envoyCfg := envoy.EnvoyConfig{
		Credentials: resolved,
		TLS:         tlsMaterial,
	}
	if wl.Spec.Network.Allowlist != nil {
		envoyCfg.Allowlist = wl.Spec.Network.Allowlist
	}

	envoyYAML, err := envoy.GenerateEnvoyYAML(envoyCfg)
	if err != nil {
		return nil, fmt.Errorf("generating envoy config: %w", err)
	}

	return &ProxyConfig{
		EnvoyYAML: envoyYAML,
		CACert:    tlsMaterial.CACert,
		TLS:       tlsMaterial,
	}, nil
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

// releaseClaim extracts a snapshot (if applicable), deletes the Pod, and sets phase=Released.
func (r *ClaimReconciler) releaseClaim(ctx context.Context, claim *v1alpha1.BoilerhouseClaim, action string) (reconcile.Result, error) {
	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef
	ns := claim.Namespace

	pod, err := r.findTenantPod(ctx, ns, tenantId, workloadRef)
	if err != nil {
		return reconcile.Result{}, err
	}

	if pod != nil {
		// Extract snapshot before deleting, if action is hibernate and we have overlay dirs.
		if action == "hibernate" && r.Snapshots != nil {
			var wl v1alpha1.BoilerhouseWorkload
			wlKey := types.NamespacedName{Name: workloadRef, Namespace: ns}
			if err := r.Get(ctx, wlKey, &wl); err == nil {
				if wl.Spec.Filesystem != nil && len(wl.Spec.Filesystem.OverlayDirs) > 0 {
					if err := r.Snapshots.ExtractAndStore(ctx, pod.Name, tenantId, workloadRef, wl.Spec.Filesystem.OverlayDirs); err != nil {
						ctrl.LoggerFrom(ctx).Error(err, "extracting snapshot on release", "tenant", tenantId, "workload", workloadRef)
					}
				}
			}
		}

		// If action=destroy, also delete any stored snapshot.
		if action == "destroy" && r.Snapshots != nil {
			if err := r.Snapshots.DeleteSnapshot(ctx, tenantId, workloadRef); err != nil {
				ctrl.LoggerFrom(ctx).Error(err, "deleting snapshot on destroy", "tenant", tenantId, "workload", workloadRef)
			}
		}

		// Delete the Pod.
		if err := r.Delete(ctx, pod); err != nil && !apierrors.IsNotFound(err) {
			return reconcile.Result{}, fmt.Errorf("deleting pod on release: %w", err)
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
// If the workload has overlay dirs, a snapshot is extracted before the Pod is deleted.
func (r *ClaimReconciler) handleDeletion(ctx context.Context, claim *v1alpha1.BoilerhouseClaim) (reconcile.Result, error) {
	if !controllerutil.ContainsFinalizer(claim, finalizerName) {
		return reconcile.Result{}, nil
	}

	tenantId := claim.Spec.TenantId
	workloadRef := claim.Spec.WorkloadRef
	ns := claim.Namespace

	// Look up the workload to determine idle action and overlay dirs.
	var wl v1alpha1.BoilerhouseWorkload
	wlKey := types.NamespacedName{Name: workloadRef, Namespace: ns}
	idleAction := "hibernate" // default
	if err := r.Get(ctx, wlKey, &wl); err == nil {
		if wl.Spec.Idle != nil && wl.Spec.Idle.Action != "" {
			idleAction = wl.Spec.Idle.Action
		}
	}

	// Find the tenant's Pod.
	pod, err := r.findTenantPod(ctx, ns, tenantId, workloadRef)
	if err != nil {
		return reconcile.Result{}, err
	}

	if pod != nil {
		// Extract snapshot before deletion if action is hibernate.
		if idleAction == "hibernate" && r.Snapshots != nil {
			if wl.Spec.Filesystem != nil && len(wl.Spec.Filesystem.OverlayDirs) > 0 {
				if err := r.Snapshots.ExtractAndStore(ctx, pod.Name, tenantId, workloadRef, wl.Spec.Filesystem.OverlayDirs); err != nil {
					ctrl.LoggerFrom(ctx).Error(err, "extracting snapshot on deletion", "tenant", tenantId, "workload", workloadRef)
				}
			}
		}

		// If action=destroy, delete the snapshot too.
		if idleAction == "destroy" && r.Snapshots != nil {
			if err := r.Snapshots.DeleteSnapshot(ctx, tenantId, workloadRef); err != nil {
				ctrl.LoggerFrom(ctx).Error(err, "deleting snapshot on destroy", "tenant", tenantId, "workload", workloadRef)
			}
		}

		// Delete the Pod.
		if err := r.Delete(ctx, pod); err != nil && !apierrors.IsNotFound(err) {
			return reconcile.Result{}, fmt.Errorf("deleting pod on claim deletion: %w", err)
		}
	}

	// Remove finalizer.
	controllerutil.RemoveFinalizer(claim, finalizerName)
	if err := r.Update(ctx, claim); err != nil {
		return reconcile.Result{}, err
	}

	return reconcile.Result{}, nil
}


// SetupWithManager registers the ClaimReconciler with the controller manager.
func (r *ClaimReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.BoilerhouseClaim{}).
		Complete(r)
}
