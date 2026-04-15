package operator

import (
	"context"
	"crypto/rand"
	"fmt"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const defaultMaxFillConcurrency = 2

// PoolReconciler reconciles BoilerhousePool objects.
type PoolReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile handles a single reconciliation loop for a BoilerhousePool.
func (r *PoolReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	// 1. Get the pool.
	var pool v1alpha1.BoilerhousePool
	if err := r.Get(ctx, req.NamespacedName, &pool); err != nil {
		if apierrors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		return reconcile.Result{}, err
	}

	// 2. Add finalizer if missing.
	if !controllerutil.ContainsFinalizer(&pool, finalizerName) {
		controllerutil.AddFinalizer(&pool, finalizerName)
		if err := r.Update(ctx, &pool); err != nil {
			return reconcile.Result{}, err
		}
		// Re-fetch after update to get the latest resourceVersion.
		if err := r.Get(ctx, req.NamespacedName, &pool); err != nil {
			return reconcile.Result{}, err
		}
	}

	// 3. Handle deletion (deletionTimestamp set).
	if !pool.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&pool, finalizerName) {
			if err := r.deletePoolPods(ctx, pool.Namespace, pool.Spec.WorkloadRef); err != nil {
				return reconcile.Result{}, fmt.Errorf("cleaning up pool pods: %w", err)
			}

			controllerutil.RemoveFinalizer(&pool, finalizerName)
			if err := r.Update(ctx, &pool); err != nil {
				return reconcile.Result{}, err
			}
		}
		return reconcile.Result{}, nil
	}

	// 4. Look up the referenced BoilerhouseWorkload.
	var wl v1alpha1.BoilerhouseWorkload
	wlKey := types.NamespacedName{Name: pool.Spec.WorkloadRef, Namespace: pool.Namespace}
	if err := r.Get(ctx, wlKey, &wl); err != nil {
		if apierrors.IsNotFound(err) {
			return r.setPoolStatus(ctx, &pool, 0, 0, "Error", "workload not found")
		}
		return reconcile.Result{}, err
	}
	if wl.Status.Phase != "Ready" {
		return r.setPoolStatus(ctx, &pool, 0, 0, "Error", "workload not ready")
	}

	// 5. List current pool Pods (warming + ready).
	poolPods, err := r.listPoolPods(ctx, pool.Namespace, pool.Spec.WorkloadRef)
	if err != nil {
		return reconcile.Result{}, fmt.Errorf("listing pool pods: %w", err)
	}

	// 6. Relabel warming -> ready for Pods that are Running with all containers Ready.
	warmingCount := 0
	readyCount := 0
	for i := range poolPods {
		pod := &poolPods[i]
		status := pod.Labels[LabelPoolStatus]

		if status == "warming" && isPodReady(pod) {
			pod.Labels[LabelPoolStatus] = "ready"
			if err := r.Update(ctx, pod); err != nil {
				return reconcile.Result{}, fmt.Errorf("relabeling pod %s: %w", pod.Name, err)
			}
			readyCount++
		} else if status == "ready" {
			readyCount++
		} else if status == "warming" {
			warmingCount++
		}
	}

	// 7. Fill gap: create new Pods if len(poolPods) < spec.size.
	maxFill := defaultMaxFillConcurrency
	if pool.Spec.MaxFillConcurrency != nil {
		maxFill = *pool.Spec.MaxFillConcurrency
	}

	totalPoolPods := len(poolPods)
	gap := pool.Spec.Size - totalPoolPods
	if gap > 0 {
		// Limit by maxFillConcurrency: don't exceed maxFill currently-warming Pods.
		canCreate := maxFill - warmingCount
		if canCreate > gap {
			canCreate = gap
		}
		for i := 0; i < canCreate; i++ {
			suffix := randomSuffix()
			instanceId := fmt.Sprintf("%s-pool-%s", pool.Spec.WorkloadRef, suffix)

			result, err := Translate(wl.Spec, TranslateOpts{
				InstanceId:   instanceId,
				WorkloadName: pool.Spec.WorkloadRef,
				Namespace:    pool.Namespace,
				PoolStatus:   "warming",
			})
			if err != nil {
				return reconcile.Result{}, fmt.Errorf("translating pool pod: %w", err)
			}

			if err := r.Create(ctx, result.Pod); err != nil {
				return reconcile.Result{}, fmt.Errorf("creating pool pod: %w", err)
			}
			warmingCount++
		}
	}

	// 8. Update Pool status.
	phase := "Healthy"
	if warmingCount > 0 {
		phase = "Degraded"
	}

	return r.setPoolStatus(ctx, &pool, readyCount, warmingCount, phase, "")
}

// setPoolStatus updates the pool's status subresource and returns a result with requeue.
func (r *PoolReconciler) setPoolStatus(ctx context.Context, pool *v1alpha1.BoilerhousePool, ready, warming int, phase, detail string) (reconcile.Result, error) {
	pool.Status.Ready = ready
	pool.Status.Warming = warming
	pool.Status.Phase = phase

	if err := r.Status().Update(ctx, pool); err != nil {
		return reconcile.Result{}, err
	}

	return reconcile.Result{RequeueAfter: 10 * time.Second}, nil
}

// listPoolPods returns all Pods with pool-status label for the given workload.
func (r *PoolReconciler) listPoolPods(ctx context.Context, namespace, workloadRef string) ([]corev1.Pod, error) {
	var podList corev1.PodList
	if err := r.List(ctx, &podList,
		client.InNamespace(namespace),
		client.MatchingLabels{LabelWorkload: workloadRef},
	); err != nil {
		return nil, err
	}

	// Filter to only pods that have a pool-status label (warming or ready).
	var poolPods []corev1.Pod
	for _, pod := range podList.Items {
		if status, ok := pod.Labels[LabelPoolStatus]; ok && (status == "warming" || status == "ready") {
			poolPods = append(poolPods, pod)
		}
	}
	return poolPods, nil
}

// deletePoolPods deletes all Pods with a pool-status label for the given workload.
func (r *PoolReconciler) deletePoolPods(ctx context.Context, namespace, workloadRef string) error {
	var podList corev1.PodList
	if err := r.List(ctx, &podList,
		client.InNamespace(namespace),
		client.MatchingLabels{LabelWorkload: workloadRef},
	); err != nil {
		return err
	}

	for i := range podList.Items {
		pod := &podList.Items[i]
		if _, ok := pod.Labels[LabelPoolStatus]; ok {
			if err := r.Delete(ctx, pod); err != nil && !apierrors.IsNotFound(err) {
				return err
			}
		}
	}
	return nil
}

// isPodReady returns true if the Pod is in Running phase and all containers are Ready.
func isPodReady(pod *corev1.Pod) bool {
	if pod.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, cond := range pod.Status.Conditions {
		if cond.Type == corev1.ContainersReady && cond.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

// randomSuffix generates a short random hex string for unique Pod naming.
func randomSuffix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// SetupWithManager registers the PoolReconciler with the controller manager.
func (r *PoolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.BoilerhousePool{}).
		Complete(r)
}
