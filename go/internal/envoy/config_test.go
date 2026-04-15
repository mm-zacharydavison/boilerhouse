package envoy

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGenerateEnvoyYAML_SingleDomain(t *testing.T) {
	cfg := EnvoyConfig{
		Credentials: []ResolvedCredential{
			{
				Domain: "api.example.com",
				Headers: map[string]string{
					"Authorization": "Bearer sk-test-123",
				},
			},
		},
	}

	yaml, err := GenerateEnvoyYAML(cfg)
	require.NoError(t, err)

	// Verify domain route present.
	assert.Contains(t, yaml, "api_example_com")
	assert.Contains(t, yaml, `"api.example.com"`)

	// Verify header injection.
	assert.Contains(t, yaml, "Authorization")
	assert.Contains(t, yaml, "Bearer sk-test-123")

	// Verify cluster.
	assert.Contains(t, yaml, "upstream_api_example_com")
	assert.Contains(t, yaml, "address: api.example.com")
	assert.Contains(t, yaml, "port_value: 443")

	// Verify no TLS listener (TLS is nil).
	assert.NotContains(t, yaml, "egress_tls")
}

func TestGenerateEnvoyYAML_MultipleDomains(t *testing.T) {
	cfg := EnvoyConfig{
		Credentials: []ResolvedCredential{
			{
				Domain:  "api.openai.com",
				Headers: map[string]string{"Authorization": "Bearer openai-key"},
			},
			{
				Domain:  "api.anthropic.com",
				Headers: map[string]string{"x-api-key": "anthropic-key"},
			},
		},
	}

	yaml, err := GenerateEnvoyYAML(cfg)
	require.NoError(t, err)

	// Both domains present.
	assert.Contains(t, yaml, "api_openai_com")
	assert.Contains(t, yaml, "api_anthropic_com")
	assert.Contains(t, yaml, "upstream_api_openai_com")
	assert.Contains(t, yaml, "upstream_api_anthropic_com")

	// Both headers present.
	assert.Contains(t, yaml, "Bearer openai-key")
	assert.Contains(t, yaml, "anthropic-key")
}

func TestGenerateEnvoyYAML_DenyDefault(t *testing.T) {
	cfg := EnvoyConfig{
		Credentials: []ResolvedCredential{
			{
				Domain:  "api.example.com",
				Headers: map[string]string{"Authorization": "Bearer test"},
			},
		},
	}

	yaml, err := GenerateEnvoyYAML(cfg)
	require.NoError(t, err)

	// Verify deny_all route.
	assert.Contains(t, yaml, "deny_all")
	assert.Contains(t, yaml, "403")
	assert.Contains(t, yaml, "blocked by boilerhouse proxy")
}

func TestGenerateEnvoyYAML_WithTLS(t *testing.T) {
	cfg := EnvoyConfig{
		Credentials: []ResolvedCredential{
			{
				Domain:  "api.example.com",
				Headers: map[string]string{"Authorization": "Bearer test"},
			},
		},
		TLS: &TLSMaterial{
			CACert: []byte("fake-ca"),
			CAKey:  []byte("fake-key"),
			Certs: []DomainCert{
				{Domain: "api.example.com", Cert: []byte("fake-cert"), Key: []byte("fake-key")},
			},
		},
	}

	yaml, err := GenerateEnvoyYAML(cfg)
	require.NoError(t, err)

	// Verify TLS listener present.
	assert.Contains(t, yaml, "egress_tls")
	assert.Contains(t, yaml, "port_value: 18443")
	assert.Contains(t, yaml, "tls_inspector")

	// Verify per-domain cert references.
	assert.Contains(t, yaml, "/etc/envoy/certs/api_example_com.crt")
	assert.Contains(t, yaml, "/etc/envoy/certs/api_example_com.key")

	// Verify SNI matching.
	assert.Contains(t, yaml, "server_names")
}

func TestSafeDomain(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"api.example.com", "api_example_com"},
		{"*.example.com", "__example_com"},
		{"simple", "simple"},
		{"a.b.c.d", "a_b_c_d"},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.expected, SafeDomain(tt.input))
		})
	}
}

func TestGenerateEnvoyYAML_ValidYAMLStructure(t *testing.T) {
	cfg := EnvoyConfig{
		Credentials: []ResolvedCredential{
			{
				Domain:  "api.example.com",
				Headers: map[string]string{"Authorization": "Bearer test"},
			},
		},
	}

	yaml, err := GenerateEnvoyYAML(cfg)
	require.NoError(t, err)

	// Verify top-level structure.
	assert.True(t, strings.HasPrefix(yaml, "admin:"))
	assert.Contains(t, yaml, "static_resources:")
	assert.Contains(t, yaml, "listeners:")
	assert.Contains(t, yaml, "clusters:")
	assert.Contains(t, yaml, "egress_http")
	assert.Contains(t, yaml, "port_value: 18080")
	assert.Contains(t, yaml, "port_value: 18081")
}
