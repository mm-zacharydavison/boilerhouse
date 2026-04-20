package operator

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
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

	InjectSidecar(pod, "my-proxy-config", []string{"api.anthropic.com", "api.openai.com"})

	// Verify envoy container was added.
	require.Len(t, pod.Spec.Containers, 2)

	envoyContainer := pod.Spec.Containers[1]
	assert.Equal(t, "envoy", envoyContainer.Name)
	assert.Equal(t, EnvoyImage, envoyContainer.Image)
	assert.Equal(t, []string{"envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"}, envoyContainer.Command)

	// Verify envoy ports (transparent-proxy mode: 80 + 443).
	require.Len(t, envoyContainer.Ports, 2)
	assert.Equal(t, int32(EnvoyProxyPort), envoyContainer.Ports[0].ContainerPort)
	assert.Equal(t, int32(EnvoyTLSPort), envoyContainer.Ports[1].ContainerPort)
	assert.Equal(t, int32(80), envoyContainer.Ports[0].ContainerPort)
	assert.Equal(t, int32(443), envoyContainer.Ports[1].ContainerPort)

	// Verify envoy resources.
	assert.Equal(t, "50m", envoyContainer.Resources.Requests.Cpu().String())
	assert.Equal(t, "200m", envoyContainer.Resources.Limits.Cpu().String())

	// Verify envoy security context: NET_BIND_SERVICE added so envoy can
	// bind privileged ports 80/443 as non-root.
	require.NotNil(t, envoyContainer.SecurityContext)
	require.NotNil(t, envoyContainer.SecurityContext.Capabilities)
	assert.Equal(t, []corev1.Capability{"ALL"}, envoyContainer.SecurityContext.Capabilities.Drop)
	assert.Equal(t, []corev1.Capability{"NET_BIND_SERVICE"}, envoyContainer.SecurityContext.Capabilities.Add)
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

	// Verify hostAliases redirect each credential domain to envoy.
	require.Len(t, pod.Spec.HostAliases, 1)
	assert.Equal(t, "127.0.0.1", pod.Spec.HostAliases[0].IP)
	assert.ElementsMatch(t, []string{"api.anthropic.com", "api.openai.com"}, pod.Spec.HostAliases[0].Hostnames)

	// Verify main container env: CA certs only, no HTTP_PROXY in transparent mode.
	mainContainer := pod.Spec.Containers[0]
	envMap := map[string]string{}
	for _, e := range mainContainer.Env {
		envMap[e.Name] = e.Value
	}
	assert.NotContains(t, envMap, "HTTP_PROXY")
	assert.NotContains(t, envMap, "HTTPS_PROXY")
	assert.NotContains(t, envMap, "http_proxy")
	assert.NotContains(t, envMap, "https_proxy")
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

func TestResolveCredentials_Literal(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x-static", Value: "literal"},
			},
		},
	}

	resolved, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "api.example.com", resolved[0].Domain)
	assert.Equal(t, "literal", resolved[0].Headers["x-static"])
}

func TestResolveCredentials_SecretKeyRef(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "anthropic-api",
			Namespace: "default",
		},
		Data: map[string][]byte{"key": []byte("sk-ant-123")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.anthropic.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-api-key",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "anthropic-api", Key: "key"},
					},
				},
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "sk-ant-123", resolved[0].Headers["x-api-key"])
}

func TestResolveCredentials_MixedLiteralAndRef(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "s", Namespace: "default"},
		Data:       map[string][]byte{"k": []byte("from-secret")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x-static", Value: "literal"},
				{
					Name: "x-dynamic",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "s", Key: "k"},
					},
				},
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "literal", resolved[0].Headers["x-static"])
	assert.Equal(t, "from-secret", resolved[0].Headers["x-dynamic"])
}

func TestResolveCredentials_SecretNotFound(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-api-key",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "missing-secret", Key: "key"},
					},
				},
			},
		},
	}

	_, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api.example.com")
	assert.Contains(t, err.Error(), "x-api-key")
	assert.Contains(t, err.Error(), "missing-secret")
}

func TestResolveCredentials_KeyNotFound(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "s", Namespace: "default"},
		Data:       map[string][]byte{"wrong": []byte("v")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-api-key",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "s", Key: "key"},
					},
				},
			},
		},
	}

	_, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api.example.com")
	assert.Contains(t, err.Error(), "x-api-key")
	assert.Contains(t, err.Error(), `"key"`)
}

func TestResolveCredentials_RejectsBothValueAndValueFrom(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name:  "x",
					Value: "literal",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "s", Key: "k"},
					},
				},
			},
		},
	}

	_, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "both value and valueFrom")
}

func TestResolveCredentials_RejectsNeitherValueNorValueFrom(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x"},
			},
		},
	}

	_, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "neither value nor valueFrom")
}

func TestResolveCredentials_MissingName(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Value: "literal"},
			},
		},
	}

	_, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "missing name")
}

func TestResolveCredentials_SharedSecretFetchedOnce(t *testing.T) {
	ctx, baseClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "shared", Namespace: "default"},
		Data: map[string][]byte{
			"a": []byte("val-a"),
			"b": []byte("val-b"),
		},
	}
	require.NoError(t, baseClient.Create(ctx, secret))

	wrapped := &countingClient{Client: baseClient}

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.one.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-a",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "shared", Key: "a"},
					},
				},
			},
		},
		{
			Domain: "api.two.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-b",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "shared", Key: "b"},
					},
				},
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, wrapped, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 2)
	assert.Equal(t, "val-a", resolved[0].Headers["x-a"])
	assert.Equal(t, "val-b", resolved[1].Headers["x-b"])
	assert.Equal(t, 1, wrapped.secretGets, "expected 1 Secret Get, got %d", wrapped.secretGets)
}

func TestResolveCredentials_SkipsEmptyDomain(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x", Value: "literal"},
			},
		},
		{
			Domain: "api.valid.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x", Value: "kept"},
			},
		},
	}

	resolved, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "api.valid.com", resolved[0].Domain)
	assert.Equal(t, "kept", resolved[0].Headers["x"])
}

// countingClient wraps a controller-runtime client and counts Get calls that
// target a corev1.Secret. Used by TestResolveCredentials_SharedSecretFetchedOnce.
type countingClient struct {
	client.Client
	secretGets int
}

func (c *countingClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, ok := obj.(*corev1.Secret); ok {
		c.secretGets++
	}
	return c.Client.Get(ctx, key, obj, opts...)
}
