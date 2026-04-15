//go:build e2e

package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	testNamespace  = "boilerhouse"
	defaultTimeout = 120 * time.Second
	pollInterval   = 2 * time.Second
)

var (
	k8sClient client.Client
	testScheme *runtime.Scheme
)

// initClient creates a controller-runtime client configured for the boilerhouse
// minikube profile. It must be called once from TestMain before any tests run.
func initClient() error {
	testScheme = runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(testScheme); err != nil {
		return fmt.Errorf("adding client-go scheme: %w", err)
	}
	if err := v1alpha1.AddToScheme(testScheme); err != nil {
		return fmt.Errorf("adding v1alpha1 scheme: %w", err)
	}

	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	configOverrides := &clientcmd.ConfigOverrides{
		CurrentContext: "boilerhouse",
	}
	kubeConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, configOverrides)
	cfg, err := kubeConfig.ClientConfig()
	if err != nil {
		return fmt.Errorf("loading kubeconfig for context 'boilerhouse': %w", err)
	}

	c, err := client.New(cfg, client.Options{Scheme: testScheme})
	if err != nil {
		return fmt.Errorf("creating k8s client: %w", err)
	}
	k8sClient = c
	return nil
}

// uniqueName returns a test-scoped unique name like "test-a1b2c3d4-<prefix>".
func uniqueName(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("test-%s-%s", hex.EncodeToString(b), prefix)
}

// CrdTracker tracks CRDs created during a test and deletes them on cleanup.
type CrdTracker struct {
	mu        sync.Mutex
	workloads []string
	claims    []string
	pools     []string
}

// TrackWorkload registers a workload name for cleanup.
func (t *CrdTracker) TrackWorkload(name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.workloads = append(t.workloads, name)
}

// TrackClaim registers a claim name for cleanup.
func (t *CrdTracker) TrackClaim(name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.claims = append(t.claims, name)
}

// TrackPool registers a pool name for cleanup.
func (t *CrdTracker) TrackPool(name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pools = append(t.pools, name)
}

// Cleanup deletes all tracked resources. Claims are deleted first (to unblock
// workload finalizers), then workloads, then pools.
func (t *CrdTracker) Cleanup(tb testing.TB) {
	t.mu.Lock()
	defer t.mu.Unlock()

	ctx := context.Background()

	// Delete claims first so workload finalizers can proceed.
	for _, name := range t.claims {
		claim := &v1alpha1.BoilerhouseClaim{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		}
		if err := k8sClient.Delete(ctx, claim); err != nil && !apierrors.IsNotFound(err) {
			tb.Logf("cleanup: failed to delete claim %s: %v", name, err)
		}
	}
	// Wait for claim deletions to propagate.
	for _, name := range t.claims {
		_ = waitForCRDeletion(&v1alpha1.BoilerhouseClaim{}, name, 30*time.Second)
	}

	for _, name := range t.workloads {
		wl := &v1alpha1.BoilerhouseWorkload{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		}
		if err := k8sClient.Delete(ctx, wl); err != nil && !apierrors.IsNotFound(err) {
			tb.Logf("cleanup: failed to delete workload %s: %v", name, err)
		}
	}
	for _, name := range t.workloads {
		_ = waitForCRDeletion(&v1alpha1.BoilerhouseWorkload{}, name, 30*time.Second)
	}

	for _, name := range t.pools {
		pool := &v1alpha1.BoilerhousePool{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		}
		if err := k8sClient.Delete(ctx, pool); err != nil && !apierrors.IsNotFound(err) {
			tb.Logf("cleanup: failed to delete pool %s: %v", name, err)
		}
	}
}

// gvkForResource maps plural resource names to schema.GroupVersionKind.
func gvkForResource(resource string) schema.GroupVersionKind {
	switch resource {
	case "boilerhouseworkloads":
		return schema.GroupVersionKind{
			Group:   "boilerhouse.dev",
			Version: "v1alpha1",
			Kind:    "BoilerhouseWorkload",
		}
	case "boilerhouseclaims":
		return schema.GroupVersionKind{
			Group:   "boilerhouse.dev",
			Version: "v1alpha1",
			Kind:    "BoilerhouseClaim",
		}
	case "boilerhousepools":
		return schema.GroupVersionKind{
			Group:   "boilerhouse.dev",
			Version: "v1alpha1",
			Kind:    "BoilerhousePool",
		}
	default:
		panic(fmt.Sprintf("unknown resource: %s", resource))
	}
}

// waitForPhase polls a CRD's status.phase until it matches the expected value
// or the timeout expires. It returns the full status map on success.
func waitForPhase(resource, name, phase string, timeout time.Duration) (map[string]interface{}, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		obj := &unstructured.Unstructured{}
		obj.SetGroupVersionKind(gvkForResource(resource))

		err := k8sClient.Get(context.Background(), types.NamespacedName{
			Name:      name,
			Namespace: testNamespace,
		}, obj)
		if err != nil {
			if apierrors.IsNotFound(err) {
				time.Sleep(pollInterval)
				continue
			}
			return nil, fmt.Errorf("getting %s/%s: %w", resource, name, err)
		}

		status, ok := obj.Object["status"].(map[string]interface{})
		if ok {
			currentPhase, _ := status["phase"].(string)
			if currentPhase == phase {
				return status, nil
			}
		}

		time.Sleep(pollInterval)
	}
	return nil, fmt.Errorf("timed out waiting for %s/%s to reach phase %q", resource, name, phase)
}

// waitForDeletion polls until a resource (by plural name) returns 404.
func waitForDeletion(resource, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		obj := &unstructured.Unstructured{}
		obj.SetGroupVersionKind(gvkForResource(resource))

		err := k8sClient.Get(context.Background(), types.NamespacedName{
			Name:      name,
			Namespace: testNamespace,
		}, obj)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("getting %s/%s: %w", resource, name, err)
		}
		time.Sleep(pollInterval)
	}
	return fmt.Errorf("timed out waiting for %s/%s to be deleted", resource, name)
}

// waitForCRDeletion polls a typed object until it returns 404.
func waitForCRDeletion(obj client.Object, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		err := k8sClient.Get(context.Background(), types.NamespacedName{
			Name:      name,
			Namespace: testNamespace,
		}, obj)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("getting %s: %w", name, err)
		}
		time.Sleep(pollInterval)
	}
	return fmt.Errorf("timed out waiting for %s to be deleted", name)
}

// waitForPodPhase polls a Pod's status.phase until it matches or the timeout expires.
func waitForPodPhase(podName, phase string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var pod corev1.Pod
		err := k8sClient.Get(context.Background(), types.NamespacedName{
			Name:      podName,
			Namespace: testNamespace,
		}, &pod)
		if err != nil {
			if apierrors.IsNotFound(err) {
				time.Sleep(pollInterval)
				continue
			}
			return fmt.Errorf("getting pod %s: %w", podName, err)
		}
		if string(pod.Status.Phase) == phase {
			return nil
		}
		time.Sleep(pollInterval)
	}
	return fmt.Errorf("timed out waiting for pod %s to reach phase %q", podName, phase)
}

// waitForPodDeletion polls until the Pod returns 404 or the timeout expires.
func waitForPodDeletion(podName string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var pod corev1.Pod
		err := k8sClient.Get(context.Background(), types.NamespacedName{
			Name:      podName,
			Namespace: testNamespace,
		}, &pod)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("getting pod %s: %w", podName, err)
		}
		time.Sleep(pollInterval)
	}
	return fmt.Errorf("timed out waiting for pod %s to be deleted", podName)
}

// kubectlExec runs a command inside a Pod via kubectl exec and returns
// stdout, stderr, exit code, and any error.
func kubectlExec(podName string, command []string) (stdout, stderr string, exitCode int, err error) {
	args := []string{
		"exec", podName,
		"-n", testNamespace,
		"--context", "boilerhouse",
		"--",
	}
	args = append(args, command...)

	cmd := exec.Command("kubectl", args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	runErr := cmd.Run()
	stdout = outBuf.String()
	stderr = errBuf.String()

	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			return stdout, stderr, exitErr.ExitCode(), nil
		}
		return stdout, stderr, -1, runErr
	}
	return stdout, stderr, 0, nil
}

// resourceExists returns true if the named resource still exists.
func resourceExists(resource, name string) (bool, error) {
	obj := &unstructured.Unstructured{}
	obj.SetGroupVersionKind(gvkForResource(resource))

	err := k8sClient.Get(context.Background(), types.NamespacedName{
		Name:      name,
		Namespace: testNamespace,
	}, obj)
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// cleanStaleTestResources deletes any resources from previous test runs
// that match the "test-" prefix naming convention.
func cleanStaleTestResources() {
	ctx := context.Background()

	// Clean stale claims first.
	var claims v1alpha1.BoilerhouseClaimList
	if err := k8sClient.List(ctx, &claims, client.InNamespace(testNamespace)); err == nil {
		for i := range claims.Items {
			if strings.HasPrefix(claims.Items[i].Name, "test-") {
				_ = k8sClient.Delete(ctx, &claims.Items[i])
			}
		}
	}

	// Wait a bit for claim finalizers to clear pods.
	time.Sleep(5 * time.Second)

	// Clean stale workloads.
	var workloads v1alpha1.BoilerhouseWorkloadList
	if err := k8sClient.List(ctx, &workloads, client.InNamespace(testNamespace)); err == nil {
		for i := range workloads.Items {
			if strings.HasPrefix(workloads.Items[i].Name, "test-") {
				_ = k8sClient.Delete(ctx, &workloads.Items[i])
			}
		}
	}

	// Clean stale pools.
	var pools v1alpha1.BoilerhousePoolList
	if err := k8sClient.List(ctx, &pools, client.InNamespace(testNamespace)); err == nil {
		for i := range pools.Items {
			if strings.HasPrefix(pools.Items[i].Name, "test-") {
				_ = k8sClient.Delete(ctx, &pools.Items[i])
			}
		}
	}
}
