package operator

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

func TestInjectSidecar(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-pod",
			Namespace: "default",
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "main",
					Image: "nginx:latest",
				},
			},
		},
	}

	InjectSidecar(pod, "my-proxy-config")

	// Verify envoy container was added.
	require.Len(t, pod.Spec.Containers, 2)

	envoyContainer := pod.Spec.Containers[1]
	assert.Equal(t, "envoy", envoyContainer.Name)
	assert.Equal(t, EnvoyImage, envoyContainer.Image)
	assert.Equal(t, []string{"envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"}, envoyContainer.Command)

	// Verify envoy ports.
	require.Len(t, envoyContainer.Ports, 2)
	assert.Equal(t, int32(EnvoyProxyPort), envoyContainer.Ports[0].ContainerPort)
	assert.Equal(t, int32(EnvoyTLSPort), envoyContainer.Ports[1].ContainerPort)

	// Verify envoy resources.
	assert.Equal(t, "50m", envoyContainer.Resources.Requests.Cpu().String())
	assert.Equal(t, "100m", envoyContainer.Resources.Limits.Cpu().String())

	// Verify envoy security context.
	require.NotNil(t, envoyContainer.SecurityContext)
	require.NotNil(t, envoyContainer.SecurityContext.Capabilities)
	assert.Equal(t, []corev1.Capability{"ALL"}, envoyContainer.SecurityContext.Capabilities.Drop)
	require.NotNil(t, envoyContainer.SecurityContext.AllowPrivilegeEscalation)
	assert.False(t, *envoyContainer.SecurityContext.AllowPrivilegeEscalation)
	require.NotNil(t, envoyContainer.SecurityContext.ReadOnlyRootFilesystem)
	assert.True(t, *envoyContainer.SecurityContext.ReadOnlyRootFilesystem)

	// Verify envoy volume mount.
	require.Len(t, envoyContainer.VolumeMounts, 1)
	assert.Equal(t, "proxy-config", envoyContainer.VolumeMounts[0].Name)
	assert.Equal(t, "/etc/envoy", envoyContainer.VolumeMounts[0].MountPath)

	// Verify proxy-config volume.
	found := false
	for _, v := range pod.Spec.Volumes {
		if v.Name == "proxy-config" {
			found = true
			require.NotNil(t, v.ConfigMap)
			assert.Equal(t, "my-proxy-config", v.ConfigMap.Name)
		}
	}
	assert.True(t, found, "proxy-config volume should exist")

	// Verify proxy env vars on main container.
	mainContainer := pod.Spec.Containers[0]
	envMap := map[string]string{}
	for _, e := range mainContainer.Env {
		envMap[e.Name] = e.Value
	}
	assert.Contains(t, envMap, "HTTP_PROXY")
	assert.Contains(t, envMap, "HTTPS_PROXY")
	assert.Contains(t, envMap, "http_proxy")
	assert.Contains(t, envMap, "https_proxy")
	assert.Contains(t, envMap, "NODE_EXTRA_CA_CERTS")
	assert.Equal(t, "/etc/envoy/ca.crt", envMap["NODE_EXTRA_CA_CERTS"])

	// Verify CA cert volume mount on main container.
	var caMount *corev1.VolumeMount
	for i := range mainContainer.VolumeMounts {
		if mainContainer.VolumeMounts[i].MountPath == "/etc/envoy/ca.crt" {
			caMount = &mainContainer.VolumeMounts[i]
			break
		}
	}
	require.NotNil(t, caMount, "main container should have CA cert mount")
	assert.Equal(t, "proxy-config", caMount.Name)
	assert.Equal(t, "ca.crt", caMount.SubPath)
	assert.True(t, caMount.ReadOnly)
}

func TestResolveCredentials_GlobalSecret(t *testing.T) {
	// Set environment variable.
	os.Setenv("OPENAI_API_KEY", "sk-test-global-123")
	defer os.Unsetenv("OPENAI_API_KEY")

	headersRaw, _ := json.Marshal(map[string]string{
		"Authorization": "Bearer ${global-secret:OPENAI_API_KEY}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.openai.com",
			Headers: &runtime.RawExtension{
				Raw: headersRaw,
			},
		},
	}

	resolved, err := ResolveCredentials(context.Background(), nil, "default", "tenant-1", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)

	assert.Equal(t, "api.openai.com", resolved[0].Domain)
	assert.Equal(t, "Bearer sk-test-global-123", resolved[0].Headers["Authorization"])
}

func TestResolveCredentials_TenantSecret(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Create tenant secret.
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "bh-secret-tenant-abc",
			Namespace: "default",
		},
		Data: map[string][]byte{
			"API_KEY": []byte("tenant-secret-value-xyz"),
		},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	headersRaw, _ := json.Marshal(map[string]string{
		"x-api-key": "${tenant-secret:API_KEY}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: &runtime.RawExtension{
				Raw: headersRaw,
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", "tenant-abc", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)

	assert.Equal(t, "api.example.com", resolved[0].Domain)
	assert.Equal(t, "tenant-secret-value-xyz", resolved[0].Headers["x-api-key"])
}

func TestResolveCredentials_MixedSecrets(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Set global env.
	os.Setenv("GLOBAL_TOKEN", "global-val")
	defer os.Unsetenv("GLOBAL_TOKEN")

	// Create tenant secret.
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "bh-secret-mix-tenant",
			Namespace: "default",
		},
		Data: map[string][]byte{
			"TENANT_KEY": []byte("tenant-val"),
		},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	headersRaw, _ := json.Marshal(map[string]string{
		"Authorization": "Bearer ${global-secret:GLOBAL_TOKEN}",
		"x-tenant-key":  "${tenant-secret:TENANT_KEY}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.mixed.com",
			Headers: &runtime.RawExtension{
				Raw: headersRaw,
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", "mix-tenant", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)

	assert.Equal(t, "Bearer global-val", resolved[0].Headers["Authorization"])
	assert.Equal(t, "tenant-val", resolved[0].Headers["x-tenant-key"])
}

func TestResolveCredentials_SkipsEmptyDomain(t *testing.T) {
	headersRaw, _ := json.Marshal(map[string]string{
		"Authorization": "Bearer test",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "",
			Headers: &runtime.RawExtension{
				Raw: headersRaw,
			},
		},
		{
			Domain: "api.valid.com",
			Headers: &runtime.RawExtension{
				Raw: headersRaw,
			},
		},
	}

	resolved, err := ResolveCredentials(context.Background(), nil, "default", "tenant-1", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "api.valid.com", resolved[0].Domain)
}
