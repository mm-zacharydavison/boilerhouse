package trigger

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
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
