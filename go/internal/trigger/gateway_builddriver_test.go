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

func TestBuildDriver_EmptyReturnsDefault(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)
	trig := &v1alpha1.BoilerhouseTrigger{Spec: v1alpha1.BoilerhouseTriggerSpec{Driver: ""}}
	drv := gw.buildDriver(context.Background(), trig)
	_, ok := drv.(*DefaultDriver)
	assert.True(t, ok)
}

func TestBuildDriver_DefaultReturnsDefault(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)
	trig := &v1alpha1.BoilerhouseTrigger{Spec: v1alpha1.BoilerhouseTriggerSpec{Driver: "default"}}
	drv := gw.buildDriver(context.Background(), trig)
	_, ok := drv.(*DefaultDriver)
	assert.True(t, ok)
}

func TestBuildDriver_ClaudeCodeReturnsClaudeCode(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)
	trig := &v1alpha1.BoilerhouseTrigger{Spec: v1alpha1.BoilerhouseTriggerSpec{Driver: "claude-code"}}
	drv := gw.buildDriver(context.Background(), trig)
	_, ok := drv.(*ClaudeCodeDriver)
	assert.True(t, ok)
}

func TestBuildDriver_OpenclawResolvesSecretRef(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "oc", Namespace: "ns"},
		Data:       map[string][]byte{"token": []byte("sek")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()
	gw := NewGateway(k8sClient, "ns", nil)

	optsJSON, _ := json.Marshal(map[string]any{
		"gatewayTokenSecretRef": map[string]any{"name": "oc", "key": "token"},
	})
	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Driver:        "openclaw",
			DriverOptions: &runtime.RawExtension{Raw: optsJSON},
		},
	}

	drv := gw.buildDriver(context.Background(), trig)
	oc, ok := drv.(*OpenclawDriver)
	require.True(t, ok, "expected *OpenclawDriver, got %T", drv)
	assert.Equal(t, "sek", oc.GatewayToken)
}

func TestBuildDriver_OpenclawLiteralGatewayToken(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)

	optsJSON, _ := json.Marshal(map[string]any{"gatewayToken": "literal"})
	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Driver:        "openclaw",
			DriverOptions: &runtime.RawExtension{Raw: optsJSON},
		},
	}
	drv := gw.buildDriver(context.Background(), trig)
	oc, ok := drv.(*OpenclawDriver)
	require.True(t, ok)
	assert.Equal(t, "literal", oc.GatewayToken)
}

func TestBuildDriver_OpenclawMissingSecretReturnsMisconfigured(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()
	gw := NewGateway(k8sClient, "ns", nil)

	optsJSON, _ := json.Marshal(map[string]any{
		"gatewayTokenSecretRef": map[string]any{"name": "missing", "key": "token"},
	})
	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Driver:        "openclaw",
			DriverOptions: &runtime.RawExtension{Raw: optsJSON},
		},
	}
	drv := gw.buildDriver(context.Background(), trig)
	_, err := drv.Send(context.Background(), "http://x", "t", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "driver misconfigured")
}

func TestBuildDriver_OpenclawMissingTokenReturnsMisconfigured(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Driver: "openclaw",
			// No DriverOptions at all.
		},
	}
	drv := gw.buildDriver(context.Background(), trig)
	_, err := drv.Send(context.Background(), "http://x", "t", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "driver misconfigured")
}

func TestBuildDriver_UnknownDriverReturnsMisconfigured(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)
	trig := &v1alpha1.BoilerhouseTrigger{Spec: v1alpha1.BoilerhouseTriggerSpec{Driver: "nope"}}
	drv := gw.buildDriver(context.Background(), trig)
	_, err := drv.Send(context.Background(), "http://x", "t", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "driver misconfigured")
	assert.Contains(t, err.Error(), `"nope"`)
}
