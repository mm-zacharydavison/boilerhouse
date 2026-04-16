package operator

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const finalizerName = "boilerhouse.dev/cleanup"

// WorkloadReconciler reconciles BoilerhouseWorkload objects.
type WorkloadReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// WorkloadsDir is the base directory containing workload Dockerfiles.
	// When a workload specifies image.dockerfile, the path is resolved relative to this dir.
	WorkloadsDir string
}

// Reconcile handles a single reconciliation loop for a BoilerhouseWorkload.
func (r *WorkloadReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	var wl v1alpha1.BoilerhouseWorkload
	if err := r.Get(ctx, req.NamespacedName, &wl); err != nil {
		if apierrors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		return reconcile.Result{}, err
	}

	// Handle deletion.
	if !wl.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&wl, finalizerName) {
			if err := r.deleteOwnedPods(ctx, wl.Namespace, wl.Name); err != nil {
				return reconcile.Result{}, fmt.Errorf("cleaning up pods: %w", err)
			}
			controllerutil.RemoveFinalizer(&wl, finalizerName)
			if err := r.Update(ctx, &wl); err != nil {
				return reconcile.Result{}, err
			}
		}
		return reconcile.Result{}, nil
	}

	// Add finalizer — return early.
	if !controllerutil.ContainsFinalizer(&wl, finalizerName) {
		controllerutil.AddFinalizer(&wl, finalizerName)
		if err := r.Update(ctx, &wl); err != nil {
			return reconcile.Result{}, err
		}
		return reconcile.Result{Requeue: true}, nil
	}

	// Already Ready, spec unchanged — no-op.
	if wl.Status.Phase == "Ready" && wl.Status.ObservedGeneration == wl.Generation {
		return reconcile.Result{}, nil
	}

	// Validate spec.
	if errs := validateWorkloadSpec(wl.Spec); len(errs) > 0 {
		wl.Status.Phase = "Error"
		wl.Status.Detail = strings.Join(errs, "; ")
		wl.Status.ObservedGeneration = wl.Generation
		return reconcile.Result{}, r.Status().Update(ctx, &wl)
	}

	// If image.dockerfile is set, build the image.
	log := ctrl.LoggerFrom(ctx)
	if wl.Spec.Image.Dockerfile != "" {
		log.Info("workload has dockerfile", "dockerfile", wl.Spec.Image.Dockerfile, "phase", wl.Status.Phase)
		imageTag := fmt.Sprintf("boilerhouse/%s:%s", wl.Name, wl.Spec.Version)

		// Set Creating while building.
		if wl.Status.Phase != "Creating" {
			wl.Status.Phase = "Creating"
			wl.Status.Detail = fmt.Sprintf("building image %s", imageTag)
			wl.Status.ObservedGeneration = wl.Generation
			if err := r.Status().Update(ctx, &wl); err != nil {
				return reconcile.Result{}, err
			}
			return reconcile.Result{Requeue: true}, nil
		}

		if err := r.buildImage(ctx, wl.Spec.Image.Dockerfile, imageTag); err != nil {
			wl.Status.Phase = "Error"
			wl.Status.Detail = fmt.Sprintf("image build failed: %v", err)
			wl.Status.ObservedGeneration = wl.Generation
			return reconcile.Result{}, r.Status().Update(ctx, &wl)
		}
	}

	// Ready.
	wl.Status.Phase = "Ready"
	wl.Status.Detail = ""
	wl.Status.ObservedGeneration = wl.Generation
	return reconcile.Result{}, r.Status().Update(ctx, &wl)
}

// buildImage builds a container image from a Dockerfile and loads it into the
// cluster's container runtime. Uses `docker build` with minikube's docker-env
// so the image is built directly in minikube's Docker daemon.
func (r *WorkloadReconciler) buildImage(ctx context.Context, dockerfile, imageTag string) error {
	dockerfilePath := dockerfile
	if r.WorkloadsDir != "" {
		dockerfilePath = filepath.Join(r.WorkloadsDir, dockerfile)
	}
	buildContext := filepath.Dir(dockerfilePath)

	// Get minikube's docker environment so we build directly in minikube's daemon.
	env := os.Environ()
	if profile := detectMinikubeProfile(); profile != "" {
		envCmd := exec.CommandContext(ctx, "minikube", "-p", profile, "docker-env", "--shell", "none")
		out, err := envCmd.Output()
		if err == nil {
			// Parse KEY=VALUE lines and add to environment.
			for _, line := range strings.Split(string(out), "\n") {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "#") && strings.Contains(line, "=") {
					env = append(env, line)
				}
			}
		}
	}

	cmd := exec.CommandContext(ctx, "docker", "build", "-t", imageTag, "-f", dockerfilePath, buildContext)
	cmd.Env = env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker build: %w (stderr: %s)", err, stderr.String())
	}
	return nil
}

// detectMinikubeProfile returns the active minikube profile name, or empty string.
func detectMinikubeProfile() string {
	cmd := exec.Command("minikube", "profile", "list", "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	// Simple heuristic: if minikube is available and has profiles, use "boilerhouse" if it exists.
	if strings.Contains(string(out), "boilerhouse") {
		return "boilerhouse"
	}
	return ""
}

// ResolvedImageRef returns the image reference to use in Pod specs.
// For Dockerfile-based workloads, this is boilerhouse/<name>:<version>.
// For ref-based workloads, this is the ref as-is.
func ResolvedImageRef(wl *v1alpha1.BoilerhouseWorkload) string {
	if wl.Spec.Image.Dockerfile != "" {
		return fmt.Sprintf("boilerhouse/%s:%s", wl.Name, wl.Spec.Version)
	}
	return wl.Spec.Image.Ref
}

// validateWorkloadSpec checks that required fields are set.
func validateWorkloadSpec(spec v1alpha1.BoilerhouseWorkloadSpec) []string {
	var errs []string
	if spec.Image.Ref == "" && spec.Image.Dockerfile == "" {
		errs = append(errs, "either image.ref or image.dockerfile must be set")
	}
	if spec.Image.Ref != "" && spec.Image.Dockerfile != "" {
		errs = append(errs, "image.ref and image.dockerfile are mutually exclusive")
	}
	if spec.Resources.VCPUs <= 0 {
		errs = append(errs, "resources.vcpus must be > 0")
	}
	if spec.Resources.MemoryMb <= 0 {
		errs = append(errs, "resources.memoryMb must be > 0")
	}
	return errs
}

// deleteOwnedPods deletes all pods with label boilerhouse.dev/workload=<name>.
func (r *WorkloadReconciler) deleteOwnedPods(ctx context.Context, namespace, workloadName string) error {
	var podList corev1.PodList
	if err := r.List(ctx, &podList,
		client.InNamespace(namespace),
		client.MatchingLabels{LabelWorkload: workloadName},
	); err != nil {
		return err
	}
	for i := range podList.Items {
		if err := r.Delete(ctx, &podList.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// SetupWithManager registers the WorkloadReconciler with the controller manager.
func (r *WorkloadReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.BoilerhouseWorkload{}).
		Complete(r)
}
