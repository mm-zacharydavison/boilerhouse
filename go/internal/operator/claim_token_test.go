package operator

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	"github.com/zdavison/boilerhouse/go/internal/scope"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

func TestClaimToken_ColdBootProvisionsTokenAndInjectsEnv(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wlR := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "tok-wl", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
			Network:   &v1alpha1.WorkloadNetwork{Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}}},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlKey := types.NamespacedName{Name: "tok-wl", Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlR.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "tok-claim", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "alice", WorkloadRef: "tok-wl"},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}
	claimKey := types.NamespacedName{Name: "tok-claim", Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	var got v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &got))
	require.Equal(t, "Active", got.Status.Phase)

	// Token Secret exists with correct labels + annotations + owner ref.
	var sec corev1.Secret
	require.NoError(t, k8sClient.Get(ctx,
		types.NamespacedName{Name: ClaimTokenSecretName("tok-claim"), Namespace: "default"},
		&sec))
	assert.Equal(t, "true", sec.Labels[claimtoken.LabelAPIToken])
	assert.Equal(t, "alice", sec.Labels[LabelTenant])
	assert.Equal(t, "tok-wl", sec.Labels[LabelWorkload])
	assert.Equal(t, "tok-claim", sec.Labels[claimtoken.LabelClaim])
	assert.NotEmpty(t, sec.Annotations[claimtoken.AnnotationScopes])
	assert.NotEmpty(t, sec.Annotations[claimtoken.AnnotationExpiresAt])
	assert.Len(t, sec.Data[claimtoken.DataKey], 64) // 32 random bytes, hex-encoded
	require.Len(t, sec.OwnerReferences, 1)
	assert.Equal(t, "tok-claim", sec.OwnerReferences[0].Name)
	assert.Equal(t, "BoilerhouseClaim", sec.OwnerReferences[0].Kind)

	// Default scopes written to annotation.
	expectedCSV := strings.Join(scope.DefaultAgentScopeStrings(), ",")
	assert.Equal(t, expectedCSV, sec.Annotations[claimtoken.AnnotationScopes])

	// Pod env references the Secret.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelTenant: "alice", LabelWorkload: "tok-wl"}))
	require.Len(t, podList.Items, 1)
	var keyEnv, urlEnv *corev1.EnvVar
	for i := range podList.Items[0].Spec.Containers[0].Env {
		e := &podList.Items[0].Spec.Containers[0].Env[i]
		switch e.Name {
		case "BOILERHOUSE_API_KEY":
			keyEnv = e
		case "BOILERHOUSE_API_URL":
			urlEnv = e
		}
	}
	require.NotNil(t, keyEnv, "BOILERHOUSE_API_KEY env missing")
	require.NotNil(t, keyEnv.ValueFrom)
	require.NotNil(t, keyEnv.ValueFrom.SecretKeyRef)
	assert.Equal(t, ClaimTokenSecretName("tok-claim"), keyEnv.ValueFrom.SecretKeyRef.Name)
	assert.Equal(t, "token", keyEnv.ValueFrom.SecretKeyRef.Key)
	require.NotNil(t, urlEnv)
	assert.Contains(t, urlEnv.Value, "boilerhouse-api.default.svc")
}

func TestClaimToken_IdempotentAcrossReconciles(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-idem", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
			Network:   &v1alpha1.WorkloadNetwork{Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}}},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlR := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wlKey := types.NamespacedName{Name: "wl-idem", Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlR.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "c-idem", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "bob", WorkloadRef: "wl-idem"},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}
	claimKey := types.NamespacedName{Name: "c-idem", Namespace: "default"}
	for i := 0; i < 8; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	// Read the token once, then reconcile again, and confirm the token value
	// is unchanged (no rotation per reconcile).
	secKey := types.NamespacedName{Name: ClaimTokenSecretName("c-idem"), Namespace: "default"}
	var first corev1.Secret
	require.NoError(t, k8sClient.Get(ctx, secKey, &first))
	firstToken := string(first.Data[claimtoken.DataKey])

	for i := 0; i < 3; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
	}

	var second corev1.Secret
	require.NoError(t, k8sClient.Get(ctx, secKey, &second))
	assert.Equal(t, firstToken, string(second.Data[claimtoken.DataKey]))
}

func TestClaimToken_DisabledSkipsProvisioning(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-off", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
			Network:   &v1alpha1.WorkloadNetwork{Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}}},
			APIAccess: &v1alpha1.WorkloadAPIAccess{Scopes: []string{"none"}},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlR := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wlKey := types.NamespacedName{Name: "wl-off", Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlR.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "c-off", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "carol", WorkloadRef: "wl-off"},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}
	claimKey := types.NamespacedName{Name: "c-off", Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	// Claim reaches Active but no token Secret exists.
	var got v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &got))
	require.Equal(t, "Active", got.Status.Phase)

	var sec corev1.Secret
	err := k8sClient.Get(ctx,
		types.NamespacedName{Name: ClaimTokenSecretName("c-off"), Namespace: "default"},
		&sec)
	assert.True(t, apierrors.IsNotFound(err), "expected token secret to be absent, got err=%v", err)

	// No API env vars on the Pod.
	var podList corev1.PodList
	require.NoError(t, k8sClient.List(ctx, &podList,
		client.InNamespace("default"),
		client.MatchingLabels{LabelTenant: "carol", LabelWorkload: "wl-off"}))
	require.Len(t, podList.Items, 1)
	for _, e := range podList.Items[0].Spec.Containers[0].Env {
		assert.NotEqual(t, "BOILERHOUSE_API_KEY", e.Name)
		assert.NotEqual(t, "BOILERHOUSE_API_URL", e.Name)
	}
}

func TestClaimToken_CustomScopesWritten(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-custom", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
			Network:   &v1alpha1.WorkloadNetwork{Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}}},
			APIAccess: &v1alpha1.WorkloadAPIAccess{Scopes: []string{"agent-triggers:write", "issues:write"}},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlR := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wlKey := types.NamespacedName{Name: "wl-custom", Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlR.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "c-custom", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "dan", WorkloadRef: "wl-custom"},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}
	claimKey := types.NamespacedName{Name: "c-custom", Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	var sec corev1.Secret
	require.NoError(t, k8sClient.Get(ctx,
		types.NamespacedName{Name: ClaimTokenSecretName("c-custom"), Namespace: "default"},
		&sec))
	assert.Equal(t, "agent-triggers:write,issues:write", sec.Annotations[claimtoken.AnnotationScopes])
}

func TestClaimToken_ReleaseDeletesSecret(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-rel", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
			Network:   &v1alpha1.WorkloadNetwork{Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}}},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlR := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wlKey := types.NamespacedName{Name: "wl-rel", Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlR.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "c-rel", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "erin", WorkloadRef: "wl-rel"},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}
	claimKey := types.NamespacedName{Name: "c-rel", Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	secKey := types.NamespacedName{Name: ClaimTokenSecretName("c-rel"), Namespace: "default"}
	var sec corev1.Secret
	require.NoError(t, k8sClient.Get(ctx, secKey, &sec))

	// Drive release.
	var active v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &active))
	_, err := cr.releaseClaim(ctx, &active, "hibernate")
	require.NoError(t, err)

	// Secret gone.
	err = k8sClient.Get(ctx, secKey, &sec)
	assert.True(t, apierrors.IsNotFound(err), "expected token secret to be deleted on release, err=%v", err)
}

func TestClaimToken_DeletionDeletesSecret(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	wl := &v1alpha1.BoilerhouseWorkload{
		ObjectMeta: metav1.ObjectMeta{Name: "wl-del", Namespace: "default"},
		Spec: v1alpha1.BoilerhouseWorkloadSpec{
			Version:   "1.0.0",
			Image:     v1alpha1.WorkloadImage{Ref: "nginx:latest"},
			Resources: v1alpha1.WorkloadResources{VCPUs: 1, MemoryMb: 256, DiskGb: 5},
			Network:   &v1alpha1.WorkloadNetwork{Expose: []v1alpha1.NetworkExposePort{{Guest: 8080}}},
		},
	}
	require.NoError(t, k8sClient.Create(ctx, wl))
	wlR := &WorkloadReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	wlKey := types.NamespacedName{Name: "wl-del", Namespace: "default"}
	for i := 0; i < 3; i++ {
		_, err := wlR.Reconcile(ctx, reconcile.Request{NamespacedName: wlKey})
		require.NoError(t, err)
	}

	claim := &v1alpha1.BoilerhouseClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "c-del", Namespace: "default"},
		Spec:       v1alpha1.BoilerhouseClaimSpec{TenantId: "frank", WorkloadRef: "wl-del"},
	}
	require.NoError(t, k8sClient.Create(ctx, claim))

	cr := &ClaimReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Namespace: "default"}
	claimKey := types.NamespacedName{Name: "c-del", Namespace: "default"}
	for i := 0; i < 5; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
		populateEmptyPodIPs(t, ctx, k8sClient, "default")
	}

	secKey := types.NamespacedName{Name: ClaimTokenSecretName("c-del"), Namespace: "default"}
	require.NoError(t, k8sClient.Get(ctx, secKey, &corev1.Secret{}))

	// Delete the Claim; the finalizer holds it in DeletionTimestamp-set state
	// until the reconciler's deletion handler runs.
	var active v1alpha1.BoilerhouseClaim
	require.NoError(t, k8sClient.Get(ctx, claimKey, &active))
	require.NoError(t, k8sClient.Delete(ctx, &active))

	// Reconcile should observe the deletion and clean up.
	for i := 0; i < 3; i++ {
		_, err := cr.Reconcile(ctx, reconcile.Request{NamespacedName: claimKey})
		require.NoError(t, err)
	}

	err := k8sClient.Get(ctx, secKey, &corev1.Secret{})
	assert.True(t, apierrors.IsNotFound(err), "expected token secret deleted on Claim deletion, err=%v", err)
}
