//go:build e2e

package e2e

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

var operatorCmd *exec.Cmd

func TestMain(m *testing.M) {
	// Resolve project root (go/ directory).
	_, thisFile, _, _ := runtime.Caller(0)
	goRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")

	// 1. Build the operator binary.
	fmt.Println("==> Building operator binary...")
	buildCmd := exec.Command("go", "build", "-o", "/tmp/bh-e2e-operator", "./cmd/operator/")
	buildCmd.Dir = goRoot
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to build operator: %v\n", err)
		os.Exit(1)
	}

	// 2. Apply CRDs to the cluster.
	fmt.Println("==> Applying CRDs...")
	crdDir := filepath.Join(goRoot, "..", "config", "crd", "bases-go")
	applyCmd := exec.Command("kubectl", "apply", "-f", crdDir, "--context", "boilerhouse")
	applyCmd.Stdout = os.Stdout
	applyCmd.Stderr = os.Stderr
	if err := applyCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to apply CRDs: %v\n", err)
		os.Exit(1)
	}

	// Ensure namespace exists.
	nsCmd := exec.Command("kubectl", "create", "namespace", testNamespace, "--context", "boilerhouse")
	nsCmd.Run() // ignore error if already exists

	// 3. Start the operator subprocess.
	fmt.Println("==> Starting operator...")
	operatorCmd = exec.Command("/tmp/bh-e2e-operator")
	operatorCmd.Env = append(os.Environ(),
		"LEADER_ELECT=false",
		"K8S_NAMESPACE="+testNamespace,
		"HEALTH_PORT=18081",
		"METRICS_PORT=19464",
	)
	operatorCmd.Stdout = os.Stdout
	operatorCmd.Stderr = os.Stderr
	if err := operatorCmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to start operator: %v\n", err)
		os.Exit(1)
	}

	// 4. Wait for health endpoint.
	fmt.Println("==> Waiting for operator health endpoint...")
	if err := waitForHealthEndpoint("http://localhost:18081/healthz", 30*time.Second); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: operator health check failed: %v\n", err)
		operatorCmd.Process.Kill()
		operatorCmd.Wait()
		os.Exit(1)
	}
	fmt.Println("==> Operator is healthy.")

	// 5. Init k8s client and clean stale resources.
	if err := initClient(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to init k8s client: %v\n", err)
		operatorCmd.Process.Kill()
		operatorCmd.Wait()
		os.Exit(1)
	}

	fmt.Println("==> Cleaning stale test resources...")
	cleanStaleTestResources()

	// 6. Run tests.
	fmt.Println("==> Running tests...")
	code := m.Run()

	// 7. Kill operator.
	fmt.Println("==> Shutting down operator...")
	operatorCmd.Process.Kill()
	operatorCmd.Wait()

	os.Exit(code)
}

// waitForHealthEndpoint polls the given URL until it returns 200 or times out.
func waitForHealthEndpoint(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("health endpoint %s did not become ready within %v", url, timeout)
}
