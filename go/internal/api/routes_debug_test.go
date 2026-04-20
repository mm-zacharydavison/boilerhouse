package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestListDebugResources(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	ns := srv.namespace
	ctx := t.Context()

	// One of each CRD.
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-1", Namespace: ns},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version: "1",
			Image:   v1alpha1.WorkloadImage{Ref: "busybox:latest"},
			Resources: v1alpha1.WorkloadResources{
				VCPUs:    1,
				MemoryMb: 128,
				DiskGb:   1,
			},
		},
	}))
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhousePool{
		ObjectMeta: metav1.ObjectMeta{Name: "pool-1", Namespace: ns},
		Spec: v1alpha1.BoilerhousePoolSpec{
			WorkloadRef: "wl-1",
			Size:        2,
		},
	}))
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "claim-1", Namespace: ns},
		Spec: v1alpha1.BoilerhouseClaimSpec{
			TenantId:    "tenant-a",
			WorkloadRef: "wl-1",
		},
	}))
	require.NoError(t, srv.client.Create(ctx, &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "trg-1", Namespace: ns},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "webhook",
			WorkloadRef: "wl-1",
		},
	}))

	managedLabels := map[string]string{"boilerhouse.dev/managed": "true"}

	require.NoError(t, srv.client.Create(ctx, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-managed", Namespace: ns, Labels: managedLabels},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "c", Image: "busybox:latest"}},
		},
	}))
	require.NoError(t, srv.client.Create(ctx, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-unmanaged", Namespace: ns},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "c", Image: "busybox:latest"}},
		},
	}))

	require.NoError(t, srv.client.Create(ctx, &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "pvc-1", Namespace: ns, Labels: managedLabels},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse("1Gi"),
				},
			},
		},
	}))

	require.NoError(t, srv.client.Create(ctx, &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "svc-1", Namespace: ns, Labels: managedLabels},
		Spec: corev1.ServiceSpec{
			Type:  corev1.ServiceTypeClusterIP,
			Ports: []corev1.ServicePort{{Port: 80}},
		},
	}))

	require.NoError(t, srv.client.Create(ctx, &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: "np-1", Namespace: ns, Labels: managedLabels},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "x"}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
		},
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/debug/resources", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var resp debugResourcesResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))

	// CRDs we created ourselves; the namespace is otherwise empty for them.
	assert.Len(t, resp.Workloads, 1)
	assert.Len(t, resp.Pools, 1)
	assert.Len(t, resp.Claims, 1)
	assert.Len(t, resp.Triggers, 1)

	// Native kinds: the namespace may contain apiserver-managed objects
	// (e.g. the built-in "kubernetes" Service in the default namespace),
	// so we assert the fixtures are present by name rather than by exact
	// count. Both managed and unmanaged pods should now appear since the
	// handler no longer filters by label.
	assert.NotNil(t, findEntry(resp.Pods, "pod-managed"))
	assert.NotNil(t, findEntry(resp.Pods, "pod-unmanaged"))
	assert.NotNil(t, findEntry(resp.PersistentVolumeClaims, "pvc-1"))
	assert.NotNil(t, findEntry(resp.NetworkPolicies, "np-1"))

	require.Len(t, resp.Workloads, 1)
	assert.Equal(t, "busybox:latest", resp.Workloads[0].Summary["image"])
	assert.True(t, len(resp.Workloads[0].Raw) > 2)

	require.Len(t, resp.Claims, 1)
	assert.Equal(t, "tenant-a", resp.Claims[0].Summary["tenant"])

	require.Len(t, resp.Triggers, 1)
	assert.Equal(t, "webhook", resp.Triggers[0].Summary["type"])
	assert.Equal(t, "wl-1", resp.Triggers[0].Summary["workloadRef"])

	svc := findEntry(resp.Services, "svc-1")
	require.NotNil(t, svc)
	assert.Equal(t, "ClusterIP", svc.Summary["type"])
}

func findEntry(entries []resourceEntry, name string) *resourceEntry {
	for i := range entries {
		if entries[i].Name == name {
			return &entries[i]
		}
	}
	return nil
}
