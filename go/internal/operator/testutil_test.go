package operator

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"

	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

// setupEnvtest starts an envtest environment with the Boilerhouse CRDs loaded.
// It returns a context, a controller-runtime client, and a cleanup function
// that must be called when the test finishes.
func setupEnvtest(t *testing.T) (context.Context, client.Client, func()) {
	t.Helper()

	// Resolve path to CRD YAMLs relative to this file.
	_, thisFile, _, _ := runtime.Caller(0)
	crdPath := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "config", "crd", "bases-go")

	env := &envtest.Environment{
		CRDDirectoryPaths: []string{crdPath},
	}

	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("failed to start envtest: %v", err)
	}

	// Build scheme: start from core k8s types, then add our CRDs.
	s := k8sruntime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		env.Stop()
		t.Fatalf("failed to add client-go scheme: %v", err)
	}
	if err := v1alpha1.AddToScheme(s); err != nil {
		env.Stop()
		t.Fatalf("failed to add v1alpha1 scheme: %v", err)
	}

	k8sClient, err := client.New(cfg, client.Options{Scheme: s})
	if err != nil {
		env.Stop()
		t.Fatalf("failed to create client: %v", err)
	}

	ctx := context.Background()

	cleanup := func() {
		if err := env.Stop(); err != nil {
			t.Logf("warning: failed to stop envtest: %v", err)
		}
	}

	return ctx, k8sClient, cleanup
}
