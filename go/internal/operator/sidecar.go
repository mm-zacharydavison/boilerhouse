package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/zdavison/boilerhouse/go/internal/envoy"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
)

const (
	EnvoyImage     = "docker.io/envoyproxy/envoy:v1.32-latest"
	EnvoyProxyPort = 18080
	EnvoyTLSPort   = 18443
	EnvoyAdminPort = 18081
)

// ProxyConfig holds pre-generated Envoy configuration and CA cert for sidecar injection.
type ProxyConfig struct {
	EnvoyYAML string // the generated Envoy bootstrap YAML
	CACert    []byte // PEM-encoded CA certificate for trust
	TLS       *envoy.TLSMaterial
}

// InjectSidecar modifies a Pod spec to add the Envoy sidecar container,
// proxy-config volume, and proxy env vars on the main container.
func InjectSidecar(pod *corev1.Pod, configMapName string) {
	falseVal := false
	readOnly := true

	// 1. Add envoy container.
	envoyContainer := corev1.Container{
		Name:    "envoy",
		Image:   EnvoyImage,
		Command: []string{"envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"},
		Ports: []corev1.ContainerPort{
			{ContainerPort: int32(EnvoyProxyPort), Protocol: corev1.ProtocolTCP},
			{ContainerPort: int32(EnvoyTLSPort), Protocol: corev1.ProtocolTCP},
		},
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("50m"),
				corev1.ResourceMemory: resource.MustParse("32Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("100m"),
				corev1.ResourceMemory: resource.MustParse("64Mi"),
			},
		},
		SecurityContext: &corev1.SecurityContext{
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
			},
			AllowPrivilegeEscalation: &falseVal,
			ReadOnlyRootFilesystem:   &readOnly,
		},
		VolumeMounts: []corev1.VolumeMount{
			{
				Name:      "proxy-config",
				MountPath: "/etc/envoy",
				ReadOnly:  true,
			},
		},
	}
	pod.Spec.Containers = append(pod.Spec.Containers, envoyContainer)

	// 2. Add proxy-config volume.
	pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{
		Name: "proxy-config",
		VolumeSource: corev1.VolumeSource{
			ConfigMap: &corev1.ConfigMapVolumeSource{
				LocalObjectReference: corev1.LocalObjectReference{
					Name: configMapName,
				},
			},
		},
	})

	// 3. Set proxy env vars and CA cert path on the main container.
	if len(pod.Spec.Containers) > 0 {
		proxyURL := fmt.Sprintf("http://127.0.0.1:%d", EnvoyProxyPort)
		httpsProxyURL := fmt.Sprintf("http://127.0.0.1:%d", EnvoyTLSPort)
		proxyEnvVars := []corev1.EnvVar{
			{Name: "HTTP_PROXY", Value: proxyURL},
			{Name: "HTTPS_PROXY", Value: httpsProxyURL},
			{Name: "http_proxy", Value: proxyURL},
			{Name: "https_proxy", Value: httpsProxyURL},
			{Name: "NODE_EXTRA_CA_CERTS", Value: "/etc/envoy/ca.crt"},
		}
		pod.Spec.Containers[0].Env = append(pod.Spec.Containers[0].Env, proxyEnvVars...)

		// 4. Mount the CA cert into the main container for trust.
		pod.Spec.Containers[0].VolumeMounts = append(pod.Spec.Containers[0].VolumeMounts, corev1.VolumeMount{
			Name:      "proxy-config",
			MountPath: "/etc/envoy/ca.crt",
			SubPath:   "ca.crt",
			ReadOnly:  true,
		})
	}
}

var (
	globalSecretRe = regexp.MustCompile(`\$\{global-secret:([^}]+)\}`)
	tenantSecretRe = regexp.MustCompile(`\$\{tenant-secret:([^}]+)\}`)
)

// ResolveCredentials resolves secret references in workload credential headers.
// ${global-secret:NAME} is resolved from environment variables.
// ${tenant-secret:NAME} is resolved from a K8s Secret named "bh-secret-<tenantId>".
func ResolveCredentials(ctx context.Context, k8sClient client.Client, namespace string, tenantId string, credentials []v1alpha1.NetworkCredential) ([]envoy.ResolvedCredential, error) {
	// Pre-fetch tenant secret (if any credential uses tenant-secret references).
	var tenantSecretData map[string][]byte
	tenantSecretNeeded := false
	for _, cred := range credentials {
		if cred.Headers != nil && cred.Headers.Raw != nil {
			raw := string(cred.Headers.Raw)
			if strings.Contains(raw, "${tenant-secret:") {
				tenantSecretNeeded = true
				break
			}
		}
	}

	if tenantSecretNeeded && tenantId != "" {
		secretName := fmt.Sprintf("bh-secret-%s", tenantId)
		var secret corev1.Secret
		err := k8sClient.Get(ctx, types.NamespacedName{Name: secretName, Namespace: namespace}, &secret)
		if err != nil {
			return nil, fmt.Errorf("fetching tenant secret %s: %w", secretName, err)
		}
		tenantSecretData = secret.Data
	}

	var resolved []envoy.ResolvedCredential
	for _, cred := range credentials {
		if cred.Domain == "" {
			continue
		}

		headers := make(map[string]string)
		if cred.Headers != nil && cred.Headers.Raw != nil {
			var raw map[string]string
			if err := json.Unmarshal(cred.Headers.Raw, &raw); err != nil {
				return nil, fmt.Errorf("parsing headers for domain %s: %w", cred.Domain, err)
			}

			for key, val := range raw {
				resolved, err := resolveValue(val, tenantSecretData)
				if err != nil {
					return nil, fmt.Errorf("resolving header %s for domain %s: %w", key, cred.Domain, err)
				}
				headers[key] = resolved
			}
		}

		resolved = append(resolved, envoy.ResolvedCredential{
			Domain:  cred.Domain,
			Headers: headers,
		})
	}

	return resolved, nil
}

// resolveValue replaces ${global-secret:NAME} and ${tenant-secret:NAME} references.
func resolveValue(val string, tenantSecretData map[string][]byte) (string, error) {
	// Resolve global secrets from env.
	result := globalSecretRe.ReplaceAllStringFunc(val, func(match string) string {
		parts := globalSecretRe.FindStringSubmatch(match)
		if len(parts) < 2 {
			return match
		}
		envVal := os.Getenv(parts[1])
		return envVal
	})

	// Resolve tenant secrets from K8s Secret data.
	result = tenantSecretRe.ReplaceAllStringFunc(result, func(match string) string {
		parts := tenantSecretRe.FindStringSubmatch(match)
		if len(parts) < 2 {
			return match
		}
		if tenantSecretData == nil {
			return match
		}
		if v, ok := tenantSecretData[parts[1]]; ok {
			return string(v)
		}
		return match
	})

	return result, nil
}
