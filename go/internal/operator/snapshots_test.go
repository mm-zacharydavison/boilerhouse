package operator

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSnapshotPath(t *testing.T) {
	tests := []struct {
		tenantId     string
		workloadName string
		expected     string
	}{
		{"alice", "my-agent", "/snapshots/alice/my-agent.tar.gz"},
		{"bob", "web-server", "/snapshots/bob/web-server.tar.gz"},
		{"tenant-123", "workload-abc", "/snapshots/tenant-123/workload-abc.tar.gz"},
	}

	for _, tt := range tests {
		t.Run(tt.tenantId+"/"+tt.workloadName, func(t *testing.T) {
			assert.Equal(t, tt.expected, snapshotPath(tt.tenantId, tt.workloadName))
		})
	}
}

func TestStripLeadingSlashes(t *testing.T) {
	tests := []struct {
		name     string
		input    []string
		expected []string
	}{
		{
			name:     "single dir with leading slash",
			input:    []string{"/data"},
			expected: []string{"data"},
		},
		{
			name:     "multiple dirs with leading slashes",
			input:    []string{"/data", "/workspace", "/config"},
			expected: []string{"data", "workspace", "config"},
		},
		{
			name:     "dirs without leading slashes",
			input:    []string{"data", "workspace"},
			expected: []string{"data", "workspace"},
		},
		{
			name:     "mixed dirs",
			input:    []string{"/data", "workspace", "/config"},
			expected: []string{"data", "workspace", "config"},
		},
		{
			name:     "empty slice",
			input:    []string{},
			expected: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := stripLeadingSlashes(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestSnapshotManagerConstants(t *testing.T) {
	// Verify the shared constants are sensible.
	assert.Equal(t, "boilerhouse-snapshots", snapshotsPVCName)
	assert.Equal(t, "boilerhouse-snapshot-helper", snapshotHelperPodName)
	assert.Equal(t, "busybox:1.36", snapshotHelperImage)
	assert.Equal(t, "/snapshots", snapshotsMountPath)
}

func TestNewSnapshotManager(t *testing.T) {
	sm := NewSnapshotManager("test-ns", nil)
	assert.NotNil(t, sm)
	assert.Equal(t, "test-ns", sm.namespace)
}
