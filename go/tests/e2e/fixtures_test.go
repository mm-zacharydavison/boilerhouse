//go:build e2e

package e2e

import (
	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// httpserverWorkload creates a workload that runs busybox httpd on port 8080
// with an HTTP health check.
func httpserverWorkload(name string) *v1alpha1.BoilerhouseWorkload {
	return &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: testNamespace,
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image: v1alpha1.WorkloadImage{
				Ref: "busybox:1.36",
			},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 64,
				DiskGb:   1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "mkdir -p /var/www && echo ok > /var/www/health && httpd -f -p 8080 -h /var/www"},
			},
			Network: &v1alpha1.WorkloadNetwork{
				Access: "none",
				Expose: []v1alpha1.NetworkExposePort{
					{Guest: 8080},
				},
			},
			Health: &v1alpha1.WorkloadHealth{
				IntervalSeconds:    5,
				UnhealthyThreshold: 3,
				HTTPGet: &v1alpha1.HealthHTTPGet{
					Path: "/health",
					Port: 8080,
				},
			},
		},
	}
}

// minimalWorkload creates a minimal workload (alpine, no network, sleep loop).
func minimalWorkload(name string) *v1alpha1.BoilerhouseWorkload {
	return &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: testNamespace,
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image: v1alpha1.WorkloadImage{
				Ref: "alpine:3.19",
			},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 64,
				DiskGb:   1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "while true; do sleep 3600; done"},
			},
		},
	}
}

// overlayWorkload creates a workload with overlay_dirs and hibernate idle action.
func overlayWorkload(name string) *v1alpha1.BoilerhouseWorkload {
	return &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: testNamespace,
		},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image: v1alpha1.WorkloadImage{
				Ref: "alpine:3.19",
			},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 64,
				DiskGb:   1,
			},
			Entrypoint: &v1alpha1.WorkloadEntrypoint{
				Cmd:  "sh",
				Args: []string{"-c", "while true; do sleep 3600; done"},
			},
			Filesystem: &v1alpha1.WorkloadFilesystem{
				OverlayDirs: []string{"/data"},
			},
			Idle: &v1alpha1.WorkloadIdle{
				Action: "hibernate",
			},
		},
	}
}

// newClaim creates a BoilerhouseClaim for the given tenant and workload.
func newClaim(name, tenantId, workloadRef string) *v1alpha1.BoilerhouseClaim {
	return &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: testNamespace,
		},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    tenantId,
			WorkloadRef: workloadRef,
		},
	}
}
