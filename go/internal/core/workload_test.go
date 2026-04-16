package core

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseWorkload_Minimal(t *testing.T) {
	yaml := `
name: my-app
version: "1.0"
image:
  ref: "docker.io/library/nginx:latest"
resources:
  vcpus: 2
  memory_mb: 512
network:
  access: none
idle:
  timeout_seconds: 300
`
	w, err := ParseWorkload([]byte(yaml))
	require.NoError(t, err)

	assert.Equal(t, "my-app", w.Name)
	assert.Equal(t, "1.0", w.Version)
	assert.Equal(t, "docker.io/library/nginx:latest", w.Image.Ref)
	assert.Empty(t, w.Image.Dockerfile)
	assert.Equal(t, 2, w.Resources.VCPUs)
	assert.Equal(t, 512, w.Resources.MemoryMB)
	assert.Equal(t, 2, w.Resources.DiskGB) // default
	assert.Equal(t, "none", w.Network.Access)
	assert.Equal(t, 300, w.Idle.TimeoutSeconds)
	assert.Equal(t, "hibernate", w.Idle.Action) // default
}

func TestParseWorkload_FullFeatured(t *testing.T) {
	yaml := `
name: claude-code
version: "2.0"
image:
  ref: "ghcr.io/anthropic/claude-code:latest"
resources:
  vcpus: 4
  memory_mb: 8192
  disk_gb: 20
network:
  access: restricted
  allowlist:
    - "api.anthropic.com"
    - "github.com"
  expose:
    - guest: 8080
      host_range: [30000, 30100]
  websocket: "/ws"
  credentials:
    - domain: "api.anthropic.com"
      headers:
        x-api-key: "${global-secret:ANTHROPIC_API_KEY}"
filesystem:
  overlay_dirs:
    - "/home/user"
    - "/workspace"
  encrypt_overlays: false
idle:
  timeout_seconds: 600
  action: destroy
  watch_dirs:
    - "/workspace"
health:
  interval_seconds: 10
  unhealthy_threshold: 3
  check_timeout_seconds: 30
  http_get:
    path: /healthz
    port: 8080
entrypoint:
  cmd: /usr/bin/claude
  args:
    - "--headless"
    - "--port=8080"
  workdir: /workspace
  env:
    CLAUDE_MODE: headless
    LOG_LEVEL: info
metadata:
  team: platform
  tier: premium
`
	w, err := ParseWorkload([]byte(yaml))
	require.NoError(t, err)

	// Top-level
	assert.Equal(t, "claude-code", w.Name)
	assert.Equal(t, "2.0", w.Version)

	// Image
	assert.Equal(t, "ghcr.io/anthropic/claude-code:latest", w.Image.Ref)
	assert.Empty(t, w.Image.Dockerfile)

	// Resources
	assert.Equal(t, 4, w.Resources.VCPUs)
	assert.Equal(t, 8192, w.Resources.MemoryMB)
	assert.Equal(t, 20, w.Resources.DiskGB)

	// Network
	assert.Equal(t, "restricted", w.Network.Access)
	assert.Equal(t, []string{"api.anthropic.com", "github.com"}, w.Network.Allowlist)
	require.Len(t, w.Network.Expose, 1)
	assert.Equal(t, 8080, w.Network.Expose[0].Guest)
	assert.Equal(t, [2]int{30000, 30100}, w.Network.Expose[0].HostRange)
	assert.Equal(t, "/ws", w.Network.Websocket)
	require.Len(t, w.Network.Credentials, 1)
	assert.Equal(t, "api.anthropic.com", w.Network.Credentials[0].Domain)
	assert.Equal(t, "${global-secret:ANTHROPIC_API_KEY}", w.Network.Credentials[0].Headers["x-api-key"])

	// Filesystem
	assert.Equal(t, []string{"/home/user", "/workspace"}, w.Filesystem.OverlayDirs)
	assert.Equal(t, false, w.Filesystem.EncryptOverlays)

	// Idle
	assert.Equal(t, 600, w.Idle.TimeoutSeconds)
	assert.Equal(t, "destroy", w.Idle.Action)
	assert.Equal(t, []string{"/workspace"}, w.Idle.WatchDirs)

	// Health
	require.NotNil(t, w.Health.HTTPGet)
	assert.Equal(t, "/healthz", w.Health.HTTPGet.Path)
	assert.Equal(t, 8080, w.Health.HTTPGet.Port)
	assert.Nil(t, w.Health.Exec)
	assert.Equal(t, 10, w.Health.IntervalSeconds)
	assert.Equal(t, 3, w.Health.UnhealthyThreshold)
	assert.Equal(t, 30, w.Health.CheckTimeoutSeconds)

	// Entrypoint
	assert.Equal(t, "/usr/bin/claude", w.Entrypoint.Cmd)
	assert.Equal(t, []string{"--headless", "--port=8080"}, w.Entrypoint.Args)
	assert.Equal(t, "/workspace", w.Entrypoint.Workdir)
	assert.Equal(t, "headless", w.Entrypoint.Env["CLAUDE_MODE"])
	assert.Equal(t, "info", w.Entrypoint.Env["LOG_LEVEL"])

	// Metadata
	assert.Equal(t, "platform", w.Metadata["team"])
	assert.Equal(t, "premium", w.Metadata["tier"])
}

func TestParseWorkload_Defaults(t *testing.T) {
	yaml := `
name: defaults-test
version: "1.0"
image:
  ref: "nginx:latest"
resources:
  vcpus: 1
  memory_mb: 256
`
	w, err := ParseWorkload([]byte(yaml))
	require.NoError(t, err)

	assert.Equal(t, 2, w.Resources.DiskGB, "disk_gb default should be 2")
	assert.Equal(t, true, w.Filesystem.EncryptOverlays, "encrypt_overlays default should be true")
	assert.Equal(t, 60, w.Health.CheckTimeoutSeconds, "health.check_timeout_seconds default should be 60")
	assert.Equal(t, "hibernate", w.Idle.Action, "idle.action default should be hibernate")
}

func TestParseWorkload_ValidationErrors(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name: "missing name",
			yaml: `
version: "1.0"
image:
  ref: "nginx:latest"
resources:
  vcpus: 1
  memory_mb: 256
`,
			wantErr: "name is required",
		},
		{
			name: "missing image",
			yaml: `
name: test
version: "1.0"
image: {}
resources:
  vcpus: 1
  memory_mb: 256
`,
			wantErr: "image section requires either 'ref' or 'dockerfile'",
		},
		{
			name: "both image types",
			yaml: `
name: test
version: "1.0"
image:
  ref: "nginx:latest"
  dockerfile: "./Dockerfile"
resources:
  vcpus: 1
  memory_mb: 256
`,
			wantErr: "image.ref and image.dockerfile are mutually exclusive",
		},
		{
			name: "zero vcpus",
			yaml: `
name: test
version: "1.0"
image:
  ref: "nginx:latest"
resources:
  vcpus: 0
  memory_mb: 256
`,
			wantErr: "vcpus must be greater than 0",
		},
		{
			name: "both health probes",
			yaml: `
name: test
version: "1.0"
image:
  ref: "nginx:latest"
resources:
  vcpus: 1
  memory_mb: 256
health:
  interval_seconds: 10
  unhealthy_threshold: 3
  http_get:
    path: /healthz
    port: 8080
  exec:
    command:
      - "cat"
      - "/tmp/healthy"
`,
			wantErr: "health.http_get and health.exec are mutually exclusive",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseWorkload([]byte(tt.yaml))
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}
