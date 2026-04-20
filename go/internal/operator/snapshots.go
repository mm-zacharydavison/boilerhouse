package operator

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	snapshotsPVCName       = "boilerhouse-snapshots"
	snapshotHelperPodName  = "boilerhouse-snapshot-helper"
	snapshotHelperImage    = "busybox:1.36"
	snapshotsPVCSize       = "50Gi"
	snapshotsMountPath     = "/snapshots"
)

// Snapshotter abstracts overlay snapshot storage so the claim reconciler can
// be unit-tested without a real kubectl-backed SnapshotManager.
type Snapshotter interface {
	HasSnapshot(ctx context.Context, tenantId, workloadName string) (bool, error)
	InjectSnapshot(ctx context.Context, podName, tenantId, workloadName string) error
	ExtractAndStore(ctx context.Context, podName, tenantId, workloadName string, overlayDirs []string) error
	DeleteSnapshot(ctx context.Context, tenantId, workloadName string) error
}

// SnapshotManager handles storing and retrieving tenant overlay snapshots.
// It uses kubectl exec to interact with Pods and a long-running helper Pod
// that mounts the shared snapshots PVC for file I/O.
type SnapshotManager struct {
	namespace string
	k8s       client.Client
}

// NewSnapshotManager creates a new SnapshotManager for the given namespace.
func NewSnapshotManager(namespace string, k8s client.Client) *SnapshotManager {
	return &SnapshotManager{
		namespace: namespace,
		k8s:       k8s,
	}
}

// snapshotPath returns the path within the snapshots PVC for a tenant's workload.
func snapshotPath(tenantId, workloadName string) string {
	return fmt.Sprintf("/snapshots/%s/%s.tar.gz", tenantId, workloadName)
}

// ExtractAndStore extracts overlay directories from a running Pod and stores
// the resulting tar.gz archive in the snapshots PVC.
func (s *SnapshotManager) ExtractAndStore(ctx context.Context, podName, tenantId, workloadName string, overlayDirs []string) error {
	if len(overlayDirs) == 0 {
		return nil
	}

	// 1. Extract overlay from the tenant Pod as a tar.gz archive on stdout.
	tarArgs := []string{"exec", podName, "-n", s.namespace, "--",
		"tar", "czf", "-", "-C", "/"}
	tarArgs = append(tarArgs, stripLeadingSlashes(overlayDirs)...)

	cmd := exec.CommandContext(ctx, "kubectl", tarArgs...)
	var archive bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &archive
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("extract overlay from pod %s: %w (stderr: %s)", podName, err, stderr.String())
	}

	if archive.Len() == 0 {
		return nil // nothing to store
	}

	// 2. Write the archive to the snapshots PVC via the helper Pod.
	return s.writeToSnapshotsPVC(ctx, tenantId, workloadName, archive.Bytes())
}

// HasSnapshot checks whether a snapshot archive exists for the given tenant+workload.
func (s *SnapshotManager) HasSnapshot(ctx context.Context, tenantId, workloadName string) (bool, error) {
	if err := s.ensureHelperPod(ctx); err != nil {
		return false, fmt.Errorf("ensuring helper pod: %w", err)
	}
	path := snapshotPath(tenantId, workloadName)
	return s.fileExistsInPVC(ctx, path)
}

// InjectSnapshot reads a snapshot from the PVC and injects it into a running Pod
// via kubectl exec tar extract.
func (s *SnapshotManager) InjectSnapshot(ctx context.Context, podName, tenantId, workloadName string) error {
	path := snapshotPath(tenantId, workloadName)

	// 1. Read the archive from the snapshots PVC.
	archive, err := s.readFromSnapshotsPVC(ctx, path)
	if err != nil {
		return fmt.Errorf("read snapshot: %w", err)
	}
	if len(archive) == 0 {
		return nil
	}

	// 2. Inject into the target Pod.
	// --no-same-owner + --no-same-permissions: skip restoring uid/gid/mode on
	// pre-existing directories (e.g. /workspace, /home/claude) that were created
	// by the container image with different perms. Without these flags, tar
	// fails with "Cannot utime / Cannot change mode: Operation not permitted".
	cmd := exec.CommandContext(ctx, "kubectl", "exec", "-i", podName, "-n", s.namespace,
		"--", "tar", "xzf", "-", "-C", "/", "--no-same-owner", "--no-same-permissions")
	cmd.Stdin = bytes.NewReader(archive)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("inject snapshot into pod %s: %w (stderr: %s)", podName, err, stderr.String())
	}

	return nil
}

// DeleteSnapshot removes a stored snapshot for a tenant+workload.
func (s *SnapshotManager) DeleteSnapshot(ctx context.Context, tenantId, workloadName string) error {
	if err := s.ensureHelperPod(ctx); err != nil {
		return fmt.Errorf("ensuring helper pod: %w", err)
	}
	path := snapshotPath(tenantId, workloadName)

	cmd := exec.CommandContext(ctx, "kubectl", "exec", snapshotHelperPodName, "-n", s.namespace,
		"--", "rm", "-f", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// Ignore errors (file may not exist).
		return nil
	}
	return nil
}

// ensureSnapshotsPVC creates the shared snapshots PVC if it does not exist.
func (s *SnapshotManager) ensureSnapshotsPVC(ctx context.Context) error {
	var pvc corev1.PersistentVolumeClaim
	key := types.NamespacedName{Name: snapshotsPVCName, Namespace: s.namespace}
	if err := s.k8s.Get(ctx, key, &pvc); err == nil {
		return nil // already exists
	} else if !apierrors.IsNotFound(err) {
		return fmt.Errorf("checking snapshots PVC: %w", err)
	}

	pvc = corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      snapshotsPVCName,
			Namespace: s.namespace,
			Labels: map[string]string{
				LabelManaged: "true",
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(snapshotsPVCSize),
				},
			},
		},
	}

	if err := s.k8s.Create(ctx, &pvc); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("creating snapshots PVC: %w", err)
	}
	return nil
}

// ensureHelperPod creates the long-running snapshot helper Pod if it does not exist.
// The helper Pod mounts the shared snapshots PVC and is used for all PVC file operations.
func (s *SnapshotManager) ensureHelperPod(ctx context.Context) error {
	// Ensure the PVC exists first.
	if err := s.ensureSnapshotsPVC(ctx); err != nil {
		return err
	}

	var pod corev1.Pod
	key := types.NamespacedName{Name: snapshotHelperPodName, Namespace: s.namespace}
	if err := s.k8s.Get(ctx, key, &pod); err == nil {
		// Pod exists. Check if it's running.
		if pod.Status.Phase == corev1.PodRunning {
			return nil
		}
		// If not running and not pending, delete and recreate.
		if pod.Status.Phase != corev1.PodPending {
			if err := s.k8s.Delete(ctx, &pod); err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf("deleting failed helper pod: %w", err)
			}
			// Fall through to create.
		} else {
			return nil // still starting up
		}
	} else if !apierrors.IsNotFound(err) {
		return fmt.Errorf("checking helper pod: %w", err)
	}

	falseVal := false
	terminationGrace := int64(1)
	pod = corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      snapshotHelperPodName,
			Namespace: s.namespace,
			Labels: map[string]string{
				LabelManaged: "true",
				"app":        "boilerhouse-snapshot-helper",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:    "helper",
					Image:   snapshotHelperImage,
					Command: []string{"sleep", "infinity"},
					VolumeMounts: []corev1.VolumeMount{
						{
							Name:      "snapshots",
							MountPath: snapshotsMountPath,
						},
					},
				},
			},
			Volumes: []corev1.Volume{
				{
					Name: "snapshots",
					VolumeSource: corev1.VolumeSource{
						PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
							ClaimName: snapshotsPVCName,
						},
					},
				},
			},
			RestartPolicy:                 corev1.RestartPolicyAlways,
			AutomountServiceAccountToken:  &falseVal,
			TerminationGracePeriodSeconds: &terminationGrace,
		},
	}

	if err := s.k8s.Create(ctx, &pod); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("creating helper pod: %w", err)
	}
	return nil
}

// writeToSnapshotsPVC writes data to a path within the snapshots PVC via the helper Pod.
func (s *SnapshotManager) writeToSnapshotsPVC(ctx context.Context, tenantId, workloadName string, data []byte) error {
	if err := s.ensureHelperPod(ctx); err != nil {
		return fmt.Errorf("ensuring helper pod: %w", err)
	}

	path := snapshotPath(tenantId, workloadName)
	dir := fmt.Sprintf("/snapshots/%s", tenantId)

	// mkdir -p the tenant directory.
	mkdirCmd := exec.CommandContext(ctx, "kubectl", "exec", snapshotHelperPodName, "-n", s.namespace,
		"--", "mkdir", "-p", dir)
	if err := mkdirCmd.Run(); err != nil {
		return fmt.Errorf("creating snapshot dir %s: %w", dir, err)
	}

	// Write the data via stdin.
	writeCmd := exec.CommandContext(ctx, "kubectl", "exec", "-i", snapshotHelperPodName, "-n", s.namespace,
		"--", "sh", "-c", fmt.Sprintf("cat > %s", path))
	writeCmd.Stdin = bytes.NewReader(data)
	var stderr bytes.Buffer
	writeCmd.Stderr = &stderr
	if err := writeCmd.Run(); err != nil {
		return fmt.Errorf("writing snapshot %s: %w (stderr: %s)", path, err, stderr.String())
	}

	return nil
}

// readFromSnapshotsPVC reads a file from the snapshots PVC via the helper Pod.
func (s *SnapshotManager) readFromSnapshotsPVC(ctx context.Context, path string) ([]byte, error) {
	if err := s.ensureHelperPod(ctx); err != nil {
		return nil, fmt.Errorf("ensuring helper pod: %w", err)
	}

	cmd := exec.CommandContext(ctx, "kubectl", "exec", snapshotHelperPodName, "-n", s.namespace,
		"--", "cat", path)
	var out bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("reading %s: %w (stderr: %s)", path, err, stderr.String())
	}
	return out.Bytes(), nil
}

// fileExistsInPVC checks if a file exists in the snapshots PVC via the helper Pod.
func (s *SnapshotManager) fileExistsInPVC(ctx context.Context, path string) (bool, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "exec", snapshotHelperPodName, "-n", s.namespace,
		"--", "test", "-f", path)
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	// Exit code 1 means the file doesn't exist.
	if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, err
}

// stripLeadingSlashes removes leading "/" from directory paths for use as tar arguments.
func stripLeadingSlashes(dirs []string) []string {
	result := make([]string, len(dirs))
	for i, d := range dirs {
		result[i] = strings.TrimPrefix(d, "/")
	}
	return result
}
