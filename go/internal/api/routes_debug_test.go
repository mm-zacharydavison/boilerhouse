package api

import (
	"encoding/base64"
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

	workloadGroup := findGroup(resp.Groups, "BoilerhouseWorkload")
	require.NotNil(t, workloadGroup, "BoilerhouseWorkload group should be present")
	require.Len(t, workloadGroup.Resources, 1)
	assert.Equal(t, "busybox:latest", workloadGroup.Resources[0].Summary["image"])
	assert.True(t, len(workloadGroup.Resources[0].Raw) > 2)

	poolGroup := findGroup(resp.Groups, "BoilerhousePool")
	require.NotNil(t, poolGroup)
	assert.Len(t, poolGroup.Resources, 1)

	claimGroup := findGroup(resp.Groups, "BoilerhouseClaim")
	require.NotNil(t, claimGroup)
	require.Len(t, claimGroup.Resources, 1)
	assert.Equal(t, "tenant-a", claimGroup.Resources[0].Summary["tenant"])

	triggerGroup := findGroup(resp.Groups, "BoilerhouseTrigger")
	require.NotNil(t, triggerGroup)
	require.Len(t, triggerGroup.Resources, 1)
	assert.Equal(t, "webhook", triggerGroup.Resources[0].Summary["type"])
	assert.Equal(t, "wl-1", triggerGroup.Resources[0].Summary["workloadRef"])

	// Native kinds: the namespace may contain apiserver-managed objects
	// (e.g. the built-in "kubernetes" Service in the default namespace),
	// so we assert the fixtures are present by name rather than by exact
	// count. Both managed and unmanaged pods should appear since the
	// handler no longer filters by label.
	podGroup := findGroup(resp.Groups, "Pod")
	require.NotNil(t, podGroup)
	assert.NotNil(t, findEntry(podGroup.Resources, "pod-managed"))
	assert.NotNil(t, findEntry(podGroup.Resources, "pod-unmanaged"))

	pvcGroup := findGroup(resp.Groups, "PersistentVolumeClaim")
	require.NotNil(t, pvcGroup)
	assert.NotNil(t, findEntry(pvcGroup.Resources, "pvc-1"))

	npGroup := findGroup(resp.Groups, "NetworkPolicy")
	require.NotNil(t, npGroup)
	assert.NotNil(t, findEntry(npGroup.Resources, "np-1"))

	svcGroup := findGroup(resp.Groups, "Service")
	require.NotNil(t, svcGroup)
	svc := findEntry(svcGroup.Resources, "svc-1")
	require.NotNil(t, svc)
	assert.Equal(t, "ClusterIP", svc.Summary["type"])
}

func TestListDebugResources_RedactsSecretValues(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	ns := srv.namespace
	ctx := t.Context()

	require.NoError(t, srv.client.Create(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "sec-1", Namespace: ns},
		Type:       corev1.SecretTypeOpaque,
		Data: map[string][]byte{
			"api-key": []byte("super-secret-value"),
			"token":   []byte("another-secret"),
		},
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/debug/resources", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var resp debugResourcesResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))

	group := findGroup(resp.Groups, "Secret")
	require.NotNil(t, group)
	entry := findEntry(group.Resources, "sec-1")
	require.NotNil(t, entry)

	// Summary exposes key names (sorted) and type, but not values.
	assert.Equal(t, "api-key,token", entry.Summary["keys"])
	assert.Equal(t, "Opaque", entry.Summary["type"])

	// Raw JSON must not contain the original values. Secret.data is
	// base64-encoded in the apiserver-returned representation, so check
	// both the plain and base64-encoded forms.
	rawStr := string(entry.Raw)
	assert.NotContains(t, rawStr, "super-secret-value")
	assert.NotContains(t, rawStr, base64.StdEncoding.EncodeToString([]byte("super-secret-value")))
	assert.NotContains(t, rawStr, base64.StdEncoding.EncodeToString([]byte("another-secret")))
	assert.Contains(t, rawStr, "redacted")
}

func findGroup(groups []kindGroup, kind string) *kindGroup {
	for i := range groups {
		if groups[i].Kind == kind {
			return &groups[i]
		}
	}
	return nil
}

func findEntry(entries []resourceEntry, name string) *resourceEntry {
	for i := range entries {
		if entries[i].Name == name {
			return &entries[i]
		}
	}
	return nil
}
