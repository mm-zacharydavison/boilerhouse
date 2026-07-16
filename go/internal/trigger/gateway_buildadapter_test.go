package trigger

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
)

func TestBuildAdapter_ResolvesTelegramBotTokenSecretRef(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "tg-secret", Namespace: "ns"},
		Data:       map[string][]byte{"token": []byte("12345:ABCDEF")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, err := json.Marshal(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "tg-secret", "key": "token"},
	})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "telegram",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	adapter, err := gw.buildAdapter(context.Background(), trig)
	require.NoError(t, err)
	ta, ok := adapter.(*TelegramAdapter)
	require.True(t, ok)
	assert.Equal(t, "12345:ABCDEF", ta.config["botToken"])
	_, hasRef := ta.config["botTokenSecretRef"]
	assert.False(t, hasRef, "secretRef should be removed after resolution")
}

func TestBuildAdapter_TelegramSecretMissingErrors(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, err := json.Marshal(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "missing", "key": "token"},
	})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "telegram",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	_, err = gw.buildAdapter(context.Background(), trig)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "telegram bot token secret")
}

func TestBuildAdapter_TelegramSecretWrongKeyErrors(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "tg-secret", Namespace: "ns"},
		Data:       map[string][]byte{"other": []byte("nope")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, _ := json.Marshal(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "tg-secret", "key": "token"},
	})
	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "telegram",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	_, err := gw.buildAdapter(context.Background(), trig)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "token")
}

func TestBuildAdapter_OneShot(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, err := json.Marshal(map[string]any{
		"runAt":   time.Now().Add(1 * time.Hour).UTC().Format(time.RFC3339),
		"payload": map[string]any{"task": "check inbox"},
	})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "one-shot",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	adapter, err := gw.buildAdapter(context.Background(), trig)
	require.NoError(t, err)
	_, ok := adapter.(*OneShotAdapter)
	require.True(t, ok)
}

func TestBuildAdapter_OneShotMissingRunAtErrors(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, err := json.Marshal(map[string]any{"payload": map[string]any{}})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "one-shot",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	_, err = gw.buildAdapter(context.Background(), trig)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "runAt is required")
}

func TestBuildAdapter_OneShotInvalidRunAtErrors(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, err := json.Marshal(map[string]any{"runAt": "tomorrow-ish"})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "one-shot",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	_, err = gw.buildAdapter(context.Background(), trig)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid runAt")
}

func TestMarkTriggerFired(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, v1alpha1.AddToScheme(scheme))

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "one-shot",
			WorkloadRef: "wl",
		},
		Status: v1alpha1.BoilerhouseTriggerStatus{Phase: "Active"},
	}
	k8sClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(trig).
		WithStatusSubresource(&v1alpha1.BoilerhouseTrigger{}).
		Build()
	gw := NewGateway(k8sClient, "ns", nil)

	require.NoError(t, gw.markTriggerFired(context.Background(), "ns", "t"))

	var got v1alpha1.BoilerhouseTrigger
	require.NoError(t, k8sClient.Get(context.Background(),
		types.NamespacedName{Name: "t", Namespace: "ns"}, &got))
	assert.Equal(t, "Fired", got.Status.Phase)
}

func TestMarkTriggerFired_MissingTriggerIsNoop(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, v1alpha1.AddToScheme(scheme))
	k8sClient := fake.NewClientBuilder().WithScheme(scheme).Build()
	gw := NewGateway(k8sClient, "ns", nil)

	require.NoError(t, gw.markTriggerFired(context.Background(), "ns", "gone"))
}
