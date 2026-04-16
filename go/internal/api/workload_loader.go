package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/core"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// LoadWorkloadsFromDir reads YAML workload files from a directory and creates
// BoilerhouseWorkload CRDs for any that don't already exist.
func LoadWorkloadsFromDir(ctx context.Context, k8sClient client.Client, dir, namespace string) error {
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return fmt.Errorf("glob workload dir: %w", err)
	}

	if len(files) == 0 {
		slog.Info("no workload YAML files found", "dir", dir)
		return nil
	}

	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			slog.Error("failed to read workload file", "file", f, "error", err)
			continue
		}

		w, err := core.ParseWorkload(data)
		if err != nil {
			slog.Error("failed to parse workload file", "file", f, "error", err)
			continue
		}

		// Check if CRD already exists.
		var existing v1alpha1.BoilerhouseWorkload
		err = k8sClient.Get(ctx, types.NamespacedName{Name: w.Name, Namespace: namespace}, &existing)
		if err == nil {
			slog.Info("workload already exists, skipping", "name", w.Name)
			continue
		}
		if !apierrors.IsNotFound(err) {
			slog.Error("failed to check workload", "name", w.Name, "error", err)
			continue
		}

		// Convert core.Workload to CRD and create.
		crd := workloadToCRD(w, namespace)
		if err := k8sClient.Create(ctx, crd); err != nil {
			slog.Error("failed to create workload CRD", "name", w.Name, "error", err)
			continue
		}

		slog.Info("created workload from YAML", "name", w.Name, "file", filepath.Base(f))
	}

	return nil
}

// workloadToCRD converts a core.Workload to a BoilerhouseWorkload CRD.
func workloadToCRD(w *core.Workload, namespace string) *v1alpha1.BoilerhouseWorkload {
	crd := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      w.Name,
			Namespace: namespace,
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: w.Version,
			Image:   v1alpha1.WorkloadImage{Ref: w.Image.Ref},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    w.Resources.VCPUs,
				MemoryMb: w.Resources.MemoryMB,
				DiskGb:   w.Resources.DiskGB,
			},
		},
	}

	// Network
	if w.Network.Access != "" {
		net := &v1alpha1.WorkloadNetwork{
			Access:    w.Network.Access,
			Allowlist: w.Network.Allowlist,
			Websocket: w.Network.Websocket,
		}
		for _, e := range w.Network.Expose {
			net.Expose = append(net.Expose, v1alpha1.NetworkExposePort{Guest: e.Guest})
		}
		for _, c := range w.Network.Credentials {
			headersJSON, _ := json.Marshal(c.Headers)
			net.Credentials = append(net.Credentials, v1alpha1.NetworkCredential{
				Domain:  c.Domain,
				Headers: &runtime.RawExtension{Raw: headersJSON},
			})
		}
		crd.Spec.Network = net
	}

	// Filesystem
	if len(w.Filesystem.OverlayDirs) > 0 {
		crd.Spec.Filesystem = &v1alpha1.WorkloadFilesystem{
			OverlayDirs: w.Filesystem.OverlayDirs,
		}
	}

	// Idle
	if w.Idle.TimeoutSeconds > 0 || w.Idle.Action != "" {
		crd.Spec.Idle = &v1alpha1.WorkloadIdle{
			TimeoutSeconds: w.Idle.TimeoutSeconds,
			Action:         w.Idle.Action,
			WatchDirs:      w.Idle.WatchDirs,
		}
	}

	// Health
	if w.Health.IntervalSeconds > 0 {
		h := &v1alpha1.WorkloadHealth{
			IntervalSeconds:    w.Health.IntervalSeconds,
			UnhealthyThreshold: w.Health.UnhealthyThreshold,
		}
		if w.Health.HTTPGet != nil {
			h.HTTPGet = &v1alpha1.HealthHTTPGet{
				Path: w.Health.HTTPGet.Path,
				Port: w.Health.HTTPGet.Port,
			}
		}
		if w.Health.Exec != nil {
			h.Exec = &v1alpha1.HealthExec{
				Command: w.Health.Exec.Command,
			}
		}
		crd.Spec.Health = h
	}

	// Entrypoint
	if w.Entrypoint.Cmd != "" {
		ep := &v1alpha1.WorkloadEntrypoint{
			Cmd:     w.Entrypoint.Cmd,
			Args:    w.Entrypoint.Args,
			Workdir: w.Entrypoint.Workdir,
		}
		if len(w.Entrypoint.Env) > 0 {
			envJSON, _ := json.Marshal(w.Entrypoint.Env)
			ep.Env = &runtime.RawExtension{Raw: envJSON}
		}
		crd.Spec.Entrypoint = ep
	}

	return crd
}
