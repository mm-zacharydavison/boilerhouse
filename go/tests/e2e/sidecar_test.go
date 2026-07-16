//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/operator"
)

// TestSidecarPodBecomesReady: a claim on an allowlist-only workload must
// produce a tenant pod that actually reaches Ready. The envoy egress proxy is
// injected as a native sidecar gated by a startup probe — if that probe can
// never succeed (e.g. probing a loopback-bound listener from the kubelet),
// the pod wedges in Init and no proxied workload can ever start.
func TestSidecarPodBecomesReady(t *testing.T) {
	const (
		wlName = "e2e-allowlist"
		tenant = "e2e-tenant"
	)
	ctx := context.Background()

	cleanupSidecarFixtures(t, ctx, wlName, tenant)
	t.Cleanup(func() { cleanupSidecarFixtures(t, context.Background(), wlName, tenant) })

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: wlName, Namespace: namespace},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "0.0.1",
			Image:     v1alpha1.WorkloadImage{Ref: "alpine:3.21"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 128, DiskGb: 1},
			Network: &v1alpha1.WorkloadNetwork{
				Access:    "restricted",
				Allowlist: []string{"example.com"},
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "sleep infinity"},
			},
		},
	}
	if err := k8sClient.Create(ctx, wl); err != nil {
		t.Fatalf("create workload: %v", err)
	}

	waitFor(t, 30*time.Second, "workload Ready", func() (bool, string) {
		var got v1alpha1.BoilerhouseWorkload
		if err := k8sClient.Get(ctx, types.NamespacedName{Name: wlName, Namespace: namespace}, &got); err != nil {
			return false, err.Error()
		}
		return got.Status.Phase == "Ready", "phase=" + got.Status.Phase
	})

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("claim-%s-%s", tenant, wlName),
			Namespace: namespace,
		},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    tenant,
			WorkloadRef: wlName,
		},
	}
	if err := k8sClient.Create(ctx, claim); err != nil {
		t.Fatalf("create claim: %v", err)
	}

	// Generous bound: first run pulls the envoy + alpine images into minikube.
	waitFor(t, 5*time.Minute, "tenant pod Ready", func() (bool, string) {
		pod := findE2ETenantPod(ctx, t, wlName, tenant)
		if pod == nil {
			return false, "no tenant pod yet"
		}
		for _, c := range pod.Status.Conditions {
			if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
				return true, ""
			}
		}
		return false, podStateSummary(pod)
	})
}

func findE2ETenantPod(ctx context.Context, t *testing.T, wlName, tenant string) *corev1.Pod {
	t.Helper()
	var pods corev1.PodList
	if err := k8sClient.List(ctx, &pods,
		client.InNamespace(namespace),
		client.MatchingLabels{
			operator.LabelTenant:   tenant,
			operator.LabelWorkload: wlName,
		},
	); err != nil {
		t.Fatalf("list tenant pods: %v", err)
	}
	for i := range pods.Items {
		if pods.Items[i].DeletionTimestamp.IsZero() {
			return &pods.Items[i]
		}
	}
	return nil
}

// podStateSummary renders phase + per-container state so a timeout failure
// says WHY the pod never became Ready (e.g. envoy stuck failing its startup
// probe).
func podStateSummary(pod *corev1.Pod) string {
	var b strings.Builder
	fmt.Fprintf(&b, "pod=%s phase=%s", pod.Name, pod.Status.Phase)
	describe := func(kind string, sts []corev1.ContainerStatus) {
		for _, cs := range sts {
			state := "unknown"
			switch {
			case cs.State.Running != nil:
				state = "running"
			case cs.State.Waiting != nil:
				state = "waiting:" + cs.State.Waiting.Reason
			case cs.State.Terminated != nil:
				state = fmt.Sprintf("terminated:%s(exit=%d)", cs.State.Terminated.Reason, cs.State.Terminated.ExitCode)
			}
			fmt.Fprintf(&b, " %s/%s=%s ready=%t restarts=%d", kind, cs.Name, state, cs.Ready, cs.RestartCount)
		}
	}
	describe("init", pod.Status.InitContainerStatuses)
	describe("main", pod.Status.ContainerStatuses)
	return b.String()
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		ok, detail := cond()
		if ok {
			return
		}
		last = detail
		time.Sleep(2 * time.Second)
	}
	t.Fatalf("timed out after %s waiting for %s; last state: %s", timeout, what, last)
}

func cleanupSidecarFixtures(t *testing.T, ctx context.Context, wlName, tenant string) {
	t.Helper()

	claimKey := types.NamespacedName{Name: fmt.Sprintf("claim-%s-%s", tenant, wlName), Namespace: namespace}
	var claim v1alpha1.BoilerhouseClaim
	if err := k8sClient.Get(ctx, claimKey, &claim); err == nil {
		// Strip the finalizer so cleanup doesn't depend on the release path
		// (hibernation snapshots etc.) working.
		if len(claim.Finalizers) > 0 {
			claim.Finalizers = nil
			_ = k8sClient.Update(ctx, &claim)
		}
		_ = k8sClient.Delete(ctx, &claim)
	}

	wl := &v1alpha1.BoilerhouseWorkload{ObjectMeta: metav1.ObjectMeta{Name: wlName, Namespace: namespace}}
	if err := k8sClient.Delete(ctx, wl); err != nil && !apierrors.IsNotFound(err) {
		t.Logf("cleanup workload: %v", err)
	}

	var pods corev1.PodList
	if err := k8sClient.List(ctx, &pods,
		client.InNamespace(namespace),
		client.MatchingLabels{operator.LabelTenant: tenant, operator.LabelWorkload: wlName},
	); err == nil {
		for i := range pods.Items {
			_ = k8sClient.Delete(ctx, &pods.Items[i])
		}
	}

	// Wait for the claim and pods to actually vanish so a re-run starts clean.
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		var c v1alpha1.BoilerhouseClaim
		claimGone := apierrors.IsNotFound(k8sClient.Get(ctx, claimKey, &c))
		var ps corev1.PodList
		_ = k8sClient.List(ctx, &ps,
			client.InNamespace(namespace),
			client.MatchingLabels{operator.LabelTenant: tenant, operator.LabelWorkload: wlName},
		)
		if claimGone && len(ps.Items) == 0 {
			return
		}
		time.Sleep(time.Second)
	}
	t.Logf("cleanup: fixtures still present after 60s")
}
