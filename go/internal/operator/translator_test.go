package operator

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/runtime"
)

// helper to create a RawExtension from a map of env vars.
func envRaw(m map[string]string) *runtime.RawExtension {
	b, _ := json.Marshal(m)
	return &runtime.RawExtension{Raw: b}
}

func TestTranslate_MinimalWorkload(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 512,
			DiskGb:   10,
		},
		Network: &v1alpha1.WorkloadNetwork{
			Access: "none",
		},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-001",
		WorkloadName: "my-workload",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	// Pod created with correct image and labels
	require.NotNil(t, result.Pod)
	assert.Equal(t, "inst-001", result.Pod.Name)
	assert.Equal(t, "default", result.Pod.Namespace)
	assert.Equal(t, "true", result.Pod.Labels["boilerhouse.dev/managed"])
	assert.Equal(t, "my-workload", result.Pod.Labels["boilerhouse.dev/workload"])
	assert.Equal(t, "inst-001", result.Pod.Labels["boilerhouse.dev/instance"])

	// No tenant label
	_, hasTenant := result.Pod.Labels["boilerhouse.dev/tenant"]
	assert.False(t, hasTenant)

	// No pool-status label
	_, hasPool := result.Pod.Labels["boilerhouse.dev/pool-status"]
	assert.False(t, hasPool)

	// Container image
	require.Len(t, result.Pod.Spec.Containers, 1)
	assert.Equal(t, "nginx:latest", result.Pod.Spec.Containers[0].Image)
	assert.Equal(t, "main", result.Pod.Spec.Containers[0].Name)

	// Security context
	sc := result.Pod.Spec.Containers[0].SecurityContext
	require.NotNil(t, sc)
	require.NotNil(t, sc.Capabilities)
	assert.Equal(t, []corev1.Capability{"ALL"}, sc.Capabilities.Drop)
	require.NotNil(t, sc.AllowPrivilegeEscalation)
	assert.False(t, *sc.AllowPrivilegeEscalation)

	// Pod-level seccomp profile
	require.NotNil(t, result.Pod.Spec.SecurityContext)
	require.NotNil(t, result.Pod.Spec.SecurityContext.SeccompProfile)
	assert.Equal(t, corev1.SeccompProfileTypeRuntimeDefault, result.Pod.Spec.SecurityContext.SeccompProfile.Type)

	// restartPolicy, automountServiceAccountToken, terminationGracePeriodSeconds
	assert.Equal(t, corev1.RestartPolicyNever, result.Pod.Spec.RestartPolicy)
	require.NotNil(t, result.Pod.Spec.AutomountServiceAccountToken)
	assert.False(t, *result.Pod.Spec.AutomountServiceAccountToken)
	require.NotNil(t, result.Pod.Spec.TerminationGracePeriodSeconds)
	assert.Equal(t, int64(3), *result.Pod.Spec.TerminationGracePeriodSeconds)

	// NetworkPolicy denies all egress
	require.NotNil(t, result.NetworkPolicy)
	assert.Equal(t, "inst-001", result.NetworkPolicy.Name)
	assert.Empty(t, result.NetworkPolicy.Spec.Egress)
	assert.Contains(t, result.NetworkPolicy.Spec.PolicyTypes, networkingv1.PolicyTypeEgress)

	// No Service
	assert.Nil(t, result.Service)

	// No PVC
	assert.Nil(t, result.PVC)

	// ConfigMap nil for now
	assert.Nil(t, result.ConfigMap)
}

func TestTranslate_WorkloadWithOverlayDirs(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 512,
			DiskGb:   20,
		},
		Filesystem: &v1alpha1.WorkloadFilesystem{
			OverlayDirs: []string{"/data", "/config"},
		},
		Network: &v1alpha1.WorkloadNetwork{Access: "none"},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-002",
		WorkloadName: "overlay-wl",
		TenantId:     "tenant-abc",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	// PVC created
	require.NotNil(t, result.PVC)
	assert.Equal(t, "overlay-tenant-abc-overlay-wl", result.PVC.Name)
	assert.Equal(t, "default", result.PVC.Namespace)
	assert.Contains(t, result.PVC.Spec.AccessModes, corev1.ReadWriteOnce)

	// Storage request
	storageQty := result.PVC.Spec.Resources.Requests[corev1.ResourceStorage]
	assert.Equal(t, resource.MustParse("20Gi"), storageQty)

	// Pod has volume mounts using subpaths
	container := result.Pod.Spec.Containers[0]
	require.Len(t, container.VolumeMounts, 2)
	assert.Equal(t, "/data", container.VolumeMounts[0].MountPath)
	assert.Equal(t, "data", container.VolumeMounts[0].SubPath)
	assert.Equal(t, "/config", container.VolumeMounts[1].MountPath)
	assert.Equal(t, "config", container.VolumeMounts[1].SubPath)

	// Pod has PVC volume
	require.Len(t, result.Pod.Spec.Volumes, 1)
	require.NotNil(t, result.Pod.Spec.Volumes[0].PersistentVolumeClaim)
	assert.Equal(t, "overlay-tenant-abc-overlay-wl", result.Pod.Spec.Volumes[0].PersistentVolumeClaim.ClaimName)

	// Tenant label set
	assert.Equal(t, "tenant-abc", result.Pod.Labels["boilerhouse.dev/tenant"])
}

func TestTranslate_WorkloadWithExposedPorts(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "myapp:v2"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 256,
			DiskGb:   5,
		},
		Network: &v1alpha1.WorkloadNetwork{
			Access: "none",
			Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}},
		},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-003",
		WorkloadName: "web-app",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	// Service created
	require.NotNil(t, result.Service)
	assert.Equal(t, "inst-003", result.Service.Name)
	assert.Equal(t, "default", result.Service.Namespace)
	require.Len(t, result.Service.Spec.Ports, 1)
	assert.Equal(t, int32(8080), result.Service.Spec.Ports[0].Port)
	assert.Equal(t, int32(8080), result.Service.Spec.Ports[0].TargetPort.IntVal)
	assert.Equal(t, corev1.ProtocolTCP, result.Service.Spec.Ports[0].Protocol)

	// Service selector
	assert.Equal(t, "inst-003", result.Service.Spec.Selector["boilerhouse.dev/instance"])

	// Pod has containerPort
	container := result.Pod.Spec.Containers[0]
	require.Len(t, container.Ports, 1)
	assert.Equal(t, int32(8080), container.Ports[0].ContainerPort)
	assert.Equal(t, corev1.ProtocolTCP, container.Ports[0].Protocol)
}

func TestTranslate_RestrictedNetworkPolicy(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 256,
			DiskGb:   5,
		},
		Network: &v1alpha1.WorkloadNetwork{
			Access: "restricted",
		},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-004",
		WorkloadName: "restricted-wl",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	np := result.NetworkPolicy
	require.NotNil(t, np)

	// PolicyTypes includes Egress
	assert.Contains(t, np.Spec.PolicyTypes, networkingv1.PolicyTypeEgress)

	// Two egress rules: DNS + HTTPS
	require.Len(t, np.Spec.Egress, 2)

	// Rule 0: DNS (UDP 53 + TCP 53)
	dnsRule := np.Spec.Egress[0]
	require.Len(t, dnsRule.Ports, 2)
	assert.Equal(t, 53, dnsRule.Ports[0].Port.IntValue())
	assert.Equal(t, 53, dnsRule.Ports[1].Port.IntValue())

	// Rule 1: HTTPS (TCP 443), blocks link-local
	httpsRule := np.Spec.Egress[1]
	require.Len(t, httpsRule.Ports, 1)
	assert.Equal(t, 443, httpsRule.Ports[0].Port.IntValue())
	require.Len(t, httpsRule.To, 1)
	require.NotNil(t, httpsRule.To[0].IPBlock)
	assert.Equal(t, "0.0.0.0/0", httpsRule.To[0].IPBlock.CIDR)
	assert.Contains(t, httpsRule.To[0].IPBlock.Except, "169.254.0.0/16")
}

func TestTranslate_UnrestrictedNetworkPolicy(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 256,
			DiskGb:   5,
		},
		Network: &v1alpha1.WorkloadNetwork{
			Access: "unrestricted",
		},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-005",
		WorkloadName: "unrestricted-wl",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	np := result.NetworkPolicy
	require.NotNil(t, np)

	// Two egress rules: DNS + all-except-link-local
	require.Len(t, np.Spec.Egress, 2)

	// Rule 0: DNS
	dnsRule := np.Spec.Egress[0]
	require.Len(t, dnsRule.Ports, 2)

	// Rule 1: All traffic except link-local (no port restriction)
	allRule := np.Spec.Egress[1]
	assert.Empty(t, allRule.Ports) // no port restriction
	require.Len(t, allRule.To, 1)
	require.NotNil(t, allRule.To[0].IPBlock)
	assert.Equal(t, "0.0.0.0/0", allRule.To[0].IPBlock.CIDR)
	assert.Contains(t, allRule.To[0].IPBlock.Except, "169.254.0.0/16")
}

func TestTranslate_HealthProbe(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "myapp:v1"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 256,
			DiskGb:   5,
		},
		Network: &v1alpha1.WorkloadNetwork{Access: "none"},
		Health: &v1alpha1.WorkloadHealth{
			IntervalSeconds:    10,
			UnhealthyThreshold: 3,
			HTTPGet: &v1alpha1.HealthHTTPGet{
				Path: "/healthz",
				Port: 8080,
			},
		},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-006",
		WorkloadName: "health-wl",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	probe := result.Pod.Spec.Containers[0].ReadinessProbe
	require.NotNil(t, probe)
	require.NotNil(t, probe.HTTPGet)
	assert.Equal(t, "/healthz", probe.HTTPGet.Path)
	assert.Equal(t, int32(8080), probe.HTTPGet.Port.IntVal)
	assert.Equal(t, int32(10), probe.PeriodSeconds)
	assert.Equal(t, int32(3), probe.FailureThreshold)
}

func TestTranslate_ExecHealthProbe(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "myapp:v1"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 256,
			DiskGb:   5,
		},
		Network: &v1alpha1.WorkloadNetwork{Access: "none"},
		Health: &v1alpha1.WorkloadHealth{
			IntervalSeconds:    5,
			UnhealthyThreshold: 2,
			Exec: &v1alpha1.HealthExec{
				Command: []string{"/bin/sh", "-c", "curl -f http://localhost:8080"},
			},
		},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-007",
		WorkloadName: "exec-health-wl",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	probe := result.Pod.Spec.Containers[0].ReadinessProbe
	require.NotNil(t, probe)
	require.NotNil(t, probe.Exec)
	assert.Equal(t, []string{"/bin/sh", "-c", "curl -f http://localhost:8080"}, probe.Exec.Command)
	assert.Equal(t, int32(5), probe.PeriodSeconds)
	assert.Equal(t, int32(2), probe.FailureThreshold)
	assert.Nil(t, probe.HTTPGet)
}

func TestTranslate_Entrypoint(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "myapp:v1"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 256,
			DiskGb:   5,
		},
		Network: &v1alpha1.WorkloadNetwork{Access: "none"},
		Entrypoint: &v1alpha1.WorkloadEntrypoint{
			Cmd:     "/bin/server",
			Args:    []string{"--port", "8080"},
			Workdir: "/app",
			Env:     envRaw(map[string]string{"NODE_ENV": "production", "PORT": "8080"}),
		},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-008",
		WorkloadName: "entrypoint-wl",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	container := result.Pod.Spec.Containers[0]
	assert.Equal(t, []string{"/bin/server"}, container.Command)
	assert.Equal(t, []string{"--port", "8080"}, container.Args)
	assert.Equal(t, "/app", container.WorkingDir)

	// Env vars - check both exist
	require.Len(t, container.Env, 2)
	envMap := map[string]string{}
	for _, e := range container.Env {
		envMap[e.Name] = e.Value
	}
	assert.Equal(t, "production", envMap["NODE_ENV"])
	assert.Equal(t, "8080", envMap["PORT"])
}

func TestTranslate_PoolPod(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "nginx:latest"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    1,
			MemoryMb: 256,
			DiskGb:   5,
		},
		Filesystem: &v1alpha1.WorkloadFilesystem{
			OverlayDirs: []string{"/data"},
		},
		Network: &v1alpha1.WorkloadNetwork{Access: "none"},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-009",
		WorkloadName: "pool-wl",
		Namespace:    "default",
		PoolStatus:   "warming",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	// Pool status label set
	assert.Equal(t, "warming", result.Pod.Labels["boilerhouse.dev/pool-status"])

	// No tenant label
	_, hasTenant := result.Pod.Labels["boilerhouse.dev/tenant"]
	assert.False(t, hasTenant)

	// No PVC (no tenant, even though overlay dirs are set)
	assert.Nil(t, result.PVC)
}

func TestTranslate_ResourceLimits(t *testing.T) {
	spec := v1alpha1.BoilerhouseWorkloadSpec{
		Version: "1.0.0",
		Image:   v1alpha1.WorkloadImage{Ref: "heavy:latest"},
		Resources: v1alpha1.WorkloadResources{
			VCPUs:    2,
			MemoryMb: 4096,
			DiskGb:   50,
		},
		Network: &v1alpha1.WorkloadNetwork{Access: "none"},
	}
	opts := TranslateOpts{
		InstanceId:   "inst-010",
		WorkloadName: "heavy-wl",
		Namespace:    "default",
	}

	result, err := Translate(spec, opts)
	require.NoError(t, err)

	resources := result.Pod.Spec.Containers[0].Resources

	// Limits: 2000m CPU, 4096Mi memory
	cpuLimit := resources.Limits[corev1.ResourceCPU]
	assert.Equal(t, resource.MustParse("2000m"), cpuLimit)

	memLimit := resources.Limits[corev1.ResourceMemory]
	assert.Equal(t, resource.MustParse("4096Mi"), memLimit)

	// Requests: max(100, 2*250)=500m CPU, min(4096, 128)=128Mi memory
	cpuReq := resources.Requests[corev1.ResourceCPU]
	assert.Equal(t, resource.MustParse("500m"), cpuReq)

	memReq := resources.Requests[corev1.ResourceMemory]
	assert.Equal(t, resource.MustParse("128Mi"), memReq)
}
