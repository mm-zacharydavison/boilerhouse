//go:build e2e

// Package e2e runs the operator's controllers in-process against a real
// cluster (minikube profile "boilerhouse" — see `bunx kadai run minikube`)
// and exercises full reconcile loops with real pods. Unlike the envtest-based
// controller tests, a kubelet is present, so pods actually start and probes
// actually run.
package e2e

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/operator"
)

var (
	k8sClient client.Client
	namespace = "boilerhouse"
)

func TestMain(m *testing.M) {
	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

	if ns := os.Getenv("K8S_NAMESPACE"); ns != "" {
		namespace = ns
	}

	cfg, err := ctrl.GetConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: no kubeconfig (is minikube running? `bunx kadai run minikube`): %v\n", err)
		os.Exit(1)
	}

	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = appsv1.AddToScheme(scheme)
	_ = networkingv1.AddToScheme(scheme)
	_ = v1alpha1.AddToScheme(scheme)

	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                 scheme,
		LeaderElection:         false,
		HealthProbeBindAddress: "0",
		Metrics:                metricsserver.Options{BindAddress: "0"},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: create manager: %v\n", err)
		os.Exit(1)
	}

	if err := (&operator.WorkloadReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: workload controller: %v\n", err)
		os.Exit(1)
	}
	if err := (&operator.PoolReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: pool controller: %v\n", err)
		os.Exit(1)
	}
	snapshots := operator.NewSnapshotManager(namespace, mgr.GetClient(), mgr.GetConfig())
	if err := (&operator.ClaimReconciler{
		Client:    mgr.GetClient(),
		Scheme:    mgr.GetScheme(),
		Snapshots: snapshots,
		Namespace: namespace,
	}).SetupWithManager(mgr); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: claim controller: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- mgr.Start(ctx) }()

	if !mgr.GetCache().WaitForCacheSync(ctx) {
		fmt.Fprintln(os.Stderr, "e2e: cache never synced")
		os.Exit(1)
	}
	k8sClient = mgr.GetClient()

	// The tests run their own operator — make sure an in-cluster one (from
	// `kubectl apply -k config/deploy`) isn't reconciling in parallel.
	scaleDownInClusterOperator(ctx)

	code := m.Run()
	cancel()
	select {
	case <-errCh:
	case <-time.After(10 * time.Second):
	}
	os.Exit(code)
}

func scaleDownInClusterOperator(ctx context.Context) {
	var dep appsv1.Deployment
	key := types.NamespacedName{Name: "boilerhouse-operator", Namespace: namespace}
	if err := k8sClient.Get(ctx, key, &dep); err != nil {
		if !apierrors.IsNotFound(err) {
			fmt.Fprintf(os.Stderr, "e2e: check in-cluster operator: %v\n", err)
		}
		return
	}
	if dep.Spec.Replicas != nil && *dep.Spec.Replicas == 0 {
		return
	}
	zero := int32(0)
	dep.Spec.Replicas = &zero
	if err := k8sClient.Update(ctx, &dep); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: scale down in-cluster operator: %v\n", err)
	}
}
