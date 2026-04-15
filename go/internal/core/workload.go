package core

import (
	"fmt"

	"sigs.k8s.io/yaml"
)

// ── Workload and sub-types ──────────────────────────────────────────────────

// Workload represents a parsed workload configuration (from YAML).
type Workload struct {
	Name       string             `json:"name"`
	Version    string             `json:"version"`
	Image      WorkloadImage      `json:"image"`
	Resources  WorkloadResources  `json:"resources"`
	Network    WorkloadNetwork    `json:"network"`
	Filesystem WorkloadFilesystem `json:"filesystem"`
	Idle       WorkloadIdle       `json:"idle"`
	Health     WorkloadHealth     `json:"health"`
	Entrypoint WorkloadEntrypoint `json:"entrypoint"`
	Pool       WorkloadPool       `json:"pool"`
	Metadata   map[string]any     `json:"metadata,omitempty"`
}

// WorkloadImage specifies the container image. Exactly one of Ref or
// Dockerfile must be set.
type WorkloadImage struct {
	Ref        string `json:"ref,omitempty"`
	Dockerfile string `json:"dockerfile,omitempty"`
}

// WorkloadResources defines compute resource limits for the workload.
type WorkloadResources struct {
	VCPUs    int `json:"vcpus"`
	MemoryMB int `json:"memory_mb"`
	DiskGB   int `json:"disk_gb"`
}

// WorkloadNetwork configures network access, exposed ports, and credentials.
type WorkloadNetwork struct {
	Access      string               `json:"access"`
	Allowlist   []string             `json:"allowlist,omitempty"`
	Expose      []WorkloadPortExpose `json:"expose,omitempty"`
	Websocket   string               `json:"websocket,omitempty"`
	Credentials []WorkloadCredential `json:"credentials,omitempty"`
}

// WorkloadPortExpose maps a guest port to a host port range.
type WorkloadPortExpose struct {
	Guest     int    `json:"guest"`
	HostRange [2]int `json:"host_range"`
}

// WorkloadCredential injects headers on outbound requests to a domain.
type WorkloadCredential struct {
	Domain  string            `json:"domain"`
	Headers map[string]string `json:"headers"`
}

// WorkloadFilesystem configures overlay directories and encryption.
type WorkloadFilesystem struct {
	OverlayDirs     []string `json:"overlay_dirs,omitempty"`
	EncryptOverlays bool     `json:"encrypt_overlays"`
}

// WorkloadIdle defines the idle policy for instances.
type WorkloadIdle struct {
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
	Action         string   `json:"action"`
	WatchDirs      []string `json:"watch_dirs,omitempty"`
}

// WorkloadHealth configures health checking.
type WorkloadHealth struct {
	IntervalSeconds     int                `json:"interval_seconds,omitempty"`
	UnhealthyThreshold  int                `json:"unhealthy_threshold,omitempty"`
	CheckTimeoutSeconds int                `json:"check_timeout_seconds"`
	HTTPGet             *WorkloadHTTPProbe `json:"http_get,omitempty"`
	Exec                *WorkloadExecProbe `json:"exec,omitempty"`
}

// WorkloadHTTPProbe is an HTTP health-check probe.
type WorkloadHTTPProbe struct {
	Path string `json:"path"`
	Port int    `json:"port,omitempty"`
}

// WorkloadExecProbe is an exec-based health-check probe.
type WorkloadExecProbe struct {
	Command []string `json:"command"`
}

// WorkloadEntrypoint overrides the container's default entrypoint.
type WorkloadEntrypoint struct {
	Cmd     string            `json:"cmd,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Workdir string            `json:"workdir,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// WorkloadPool configures the pre-warmed instance pool.
type WorkloadPool struct {
	Size               int `json:"size"`
	MaxFillConcurrency int `json:"max_fill_concurrency"`
}

// ── ParseWorkload ───────────────────────────────────────────────────────────

// ParseWorkload unmarshals YAML data into a Workload, applies defaults,
// and validates the result. Returns an error on invalid input.
func ParseWorkload(data []byte) (*Workload, error) {
	var w Workload
	if err := yaml.UnmarshalStrict(data, &w); err != nil {
		return nil, fmt.Errorf("parse workload YAML: %w", err)
	}

	applyDefaults(&w)

	if err := validateWorkload(&w); err != nil {
		return nil, err
	}

	return &w, nil
}

// ── Defaults ────────────────────────────────────────────────────────────────

func applyDefaults(w *Workload) {
	if w.Resources.DiskGB == 0 {
		w.Resources.DiskGB = 2
	}
	if w.Idle.Action == "" {
		w.Idle.Action = "hibernate"
	}
	if w.Health.CheckTimeoutSeconds == 0 {
		w.Health.CheckTimeoutSeconds = 60
	}
	if w.Pool.Size == 0 {
		w.Pool.Size = 3
	}
	if w.Pool.MaxFillConcurrency == 0 {
		w.Pool.MaxFillConcurrency = 2
	}
	if !w.Filesystem.EncryptOverlays && len(w.Filesystem.OverlayDirs) == 0 {
		// Only default to true when the field was not explicitly set.
		// Since Go zero-value for bool is false, we need a heuristic:
		// if there are no overlay_dirs and encrypt_overlays is false,
		// the user likely didn't provide a filesystem section at all.
		w.Filesystem.EncryptOverlays = true
	}
}

// ── Validation ──────────────────────────────────────────────────────────────

func validateWorkload(w *Workload) error {
	if w.Name == "" {
		return fmt.Errorf("name is required")
	}
	if w.Version == "" {
		return fmt.Errorf("version is required")
	}

	// Image: exactly one of ref or dockerfile
	if w.Image.Ref != "" && w.Image.Dockerfile != "" {
		return fmt.Errorf("image.ref and image.dockerfile are mutually exclusive — set only one")
	}
	if w.Image.Ref == "" && w.Image.Dockerfile == "" {
		return fmt.Errorf("image section requires either 'ref' or 'dockerfile'")
	}

	// Resources
	if w.Resources.VCPUs <= 0 {
		return fmt.Errorf("vcpus must be greater than 0")
	}
	if w.Resources.MemoryMB <= 0 {
		return fmt.Errorf("memory_mb must be greater than 0")
	}

	// Health probes: mutually exclusive
	if w.Health.HTTPGet != nil && w.Health.Exec != nil {
		return fmt.Errorf("health.http_get and health.exec are mutually exclusive — set only one")
	}

	return nil
}
