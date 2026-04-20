package operator

import (
	"context"
	"fmt"

	"github.com/zdavison/boilerhouse/go/internal/envoy"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
)

const (
	EnvoyImage = "docker.io/envoyproxy/envoy:v1.32-latest"
	// Transparent-proxy ports. Envoy binds 80 and 443 so that clients
	// requesting http://api.anthropic.com / https://api.anthropic.com
	// reach envoy directly via hostAliases (127.0.0.1). Admin stays on
	// a non-privileged port.
	EnvoyProxyPort = 80
	EnvoyTLSPort   = 443
	EnvoyAdminPort = 18081
)

// ProxyConfig holds pre-generated Envoy configuration and CA cert for sidecar injection.
type ProxyConfig struct {
	EnvoyYAML string // the generated Envoy bootstrap YAML
	CACert    []byte // PEM-encoded CA certificate for trust
	TLS       *envoy.TLSMaterial
}

// InjectSidecar modifies a Pod spec to add the Envoy sidecar container and
// wire the main container for transparent credential injection:
//   - envoy binds privileged ports 80 + 443 (via NET_BIND_SERVICE)
//   - each credential domain is aliased in /etc/hosts to 127.0.0.1 so client
//     traffic to http(s)://<domain>/... goes straight to envoy
//   - the main container trusts envoy's CA (for TLS)
//
// No HTTP_PROXY / HTTPS_PROXY env vars are set — clients connect to the
// real domain as if this pod were it, without having to understand proxies.
func InjectSidecar(pod *corev1.Pod, configMapName string, domains []string) {
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
				corev1.ResourceCPU:    resource.MustParse("100m"),
				corev1.ResourceMemory: resource.MustParse("128Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("500m"),
				corev1.ResourceMemory: resource.MustParse("1Gi"),
			},
		},
		SecurityContext: &corev1.SecurityContext{
			// Drop everything, then grant only NET_BIND_SERVICE so envoy
			// can bind privileged ports 80 + 443 as non-root.
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
				Add:  []corev1.Capability{"NET_BIND_SERVICE"},
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

	// 3. Point each credential domain at the local envoy via /etc/hosts.
	if len(domains) > 0 {
		pod.Spec.HostAliases = append(pod.Spec.HostAliases, corev1.HostAlias{
			IP:        "127.0.0.1",
			Hostnames: append([]string(nil), domains...),
		})
	}

	// 4. Main container: trust envoy's CA; no HTTP_PROXY env vars (traffic
	// is redirected via hostAliases, not a forward proxy).
	if len(pod.Spec.Containers) > 0 {
		pod.Spec.Containers[0].Env = append(pod.Spec.Containers[0].Env, corev1.EnvVar{
			Name: "NODE_EXTRA_CA_CERTS", Value: "/etc/envoy/ca.crt",
		})
		pod.Spec.Containers[0].VolumeMounts = append(pod.Spec.Containers[0].VolumeMounts, corev1.VolumeMount{
			Name:      "proxy-config",
			MountPath: "/etc/envoy/ca.crt",
			SubPath:   "ca.crt",
			ReadOnly:  true,
		})
	}
}

// ResolveCredentials resolves Secret references in workload credential headers.
// All secretKeyRefs resolve from Secrets in the operator's namespace.
func ResolveCredentials(ctx context.Context, k8sClient client.Client, namespace string, credentials []v1alpha1.NetworkCredential) ([]envoy.ResolvedCredential, error) {
	secretCache := map[string]map[string][]byte{}

	var resolved []envoy.ResolvedCredential
	for _, cred := range credentials {
		if cred.Domain == "" {
			continue
		}

		headers := make(map[string]string, len(cred.Headers))
		for _, h := range cred.Headers {
			if h.Name == "" {
				return nil, fmt.Errorf("credential for domain %s: header entry missing name", cred.Domain)
			}

			switch {
			case h.ValueFrom == nil && h.Value == "":
				return nil, fmt.Errorf("credential for domain %s: header %q has neither value nor valueFrom", cred.Domain, h.Name)
			case h.ValueFrom != nil && h.Value != "":
				return nil, fmt.Errorf("credential for domain %s: header %q sets both value and valueFrom", cred.Domain, h.Name)
			case h.ValueFrom != nil:
				v, err := resolveSecretKeyRef(ctx, k8sClient, namespace, h.ValueFrom.SecretKeyRef, secretCache)
				if err != nil {
					return nil, fmt.Errorf("credential for domain %s, header %q: %w", cred.Domain, h.Name, err)
				}
				headers[h.Name] = v
			default:
				headers[h.Name] = h.Value
			}
		}

		resolved = append(resolved, envoy.ResolvedCredential{Domain: cred.Domain, Headers: headers})
	}

	return resolved, nil
}

// resolveSecretKeyRef fetches (and caches) a Secret in the operator namespace
// and returns the value at ref.Key.
func resolveSecretKeyRef(ctx context.Context, k8sClient client.Client, namespace string, ref *v1alpha1.SecretKeyRef, cache map[string]map[string][]byte) (string, error) {
	if ref == nil {
		return "", fmt.Errorf("valueFrom.secretKeyRef is nil")
	}
	if ref.Name == "" || ref.Key == "" {
		return "", fmt.Errorf("secretKeyRef requires name and key")
	}

	data, ok := cache[ref.Name]
	if !ok {
		var secret corev1.Secret
		if err := k8sClient.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: namespace}, &secret); err != nil {
			return "", fmt.Errorf("secret %q: %w", ref.Name, err)
		}
		data = secret.Data
		cache[ref.Name] = data
	}

	value, ok := data[ref.Key]
	if !ok {
		return "", fmt.Errorf("secret %q: key %q not found", ref.Name, ref.Key)
	}
	return string(value), nil
}
