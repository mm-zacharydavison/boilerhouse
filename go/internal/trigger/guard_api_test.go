package trigger

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func apiGuardSpec(t *testing.T, cfg map[string]any) v1alpha1.TriggerGuard {
	t.Helper()
	raw, err := json.Marshal(cfg)
	require.NoError(t, err)
	return v1alpha1.TriggerGuard{
		Type:   "api",
		Config: &runtime.RawExtension{Raw: raw},
	}
}

func TestAPIGuard_AllowsWhenAPIReturnsAllowTrue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":true}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "gh-webhook",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	assert.NoError(t, err)
}

func TestAPIGuard_DeniesWithReasonFromAPI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":false,"reason":"tenant acme over quota"}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "gh-webhook",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "tenant acme over quota")
}

func TestAPIGuard_DeniesWithDefaultMessageWhenReasonMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":false}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "denied by api guard")
}

func TestAPIGuard_TruncatesOversizedReason(t *testing.T) {
	bigReason := strings.Repeat("x", 1000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":false,"reason":"` + bigReason + `"}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	// Error message contains some framing text plus the (truncated) reason.
	// The truncated reason should be exactly 256 chars of 'x'.
	assert.Contains(t, err.Error(), strings.Repeat("x", 256))
	assert.NotContains(t, err.Error(), strings.Repeat("x", 257))
}

func TestAPIGuard_FailsClosedOnTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(`{"allow":true}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     20 * time.Millisecond,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api guard unreachable")
}

func TestAPIGuard_FailsClosedOnNon200(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api guard unreachable")
}

func TestAPIGuard_FailsClosedOnMalformedJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`not json`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api guard unreachable")
}

func TestAPIGuard_FailsClosedOnMissingAllowField(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"reason":"huh"}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api guard unreachable")
}

func TestAPIGuard_SendsAuthHeaderWhenTokenSet(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":true}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     2 * time.Second,
		token:       "s3cret",
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.NoError(t, err)
	assert.Equal(t, "Bearer s3cret", gotAuth)
}

func TestAPIGuard_OmitsAuthHeaderWhenNoToken(t *testing.T) {
	var hadAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hadAuth = r.Header["Authorization"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":true}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "t",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.NoError(t, err)
	assert.False(t, hadAuth, "Authorization header should not be set when token is empty")
}

func TestAPIGuard_SendsExpectedRequestBody(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		assert.Equal(t, "boilerhouse-trigger-gateway", r.Header.Get("User-Agent"))
		body, _ := io.ReadAll(r.Body)
		require.NoError(t, json.Unmarshal(body, &got))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":true}`))
	}))
	defer server.Close()

	guard := &APIGuard{
		triggerName: "gh-webhook",
		url:         server.URL,
		timeout:     2 * time.Second,
		httpClient:  server.Client(),
	}

	payload := TriggerPayload{
		Text:   "hello",
		Source: "webhook",
		Raw:    map[string]any{"user": "U001"},
	}
	err := guard.Check(context.Background(), "acme", payload)
	require.NoError(t, err)

	assert.Equal(t, "gh-webhook", got["triggerName"])
	assert.Equal(t, "acme", got["tenantId"])
	inner, ok := got["payload"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "hello", inner["text"])
	assert.Equal(t, "webhook", inner["source"])
	raw, ok := inner["raw"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "U001", raw["user"])
}

func TestAPIGuard_MisconfiguredGuardAlwaysDenies(t *testing.T) {
	guard := &APIGuard{
		triggerName:   "t",
		misconfigured: "url missing",
	}

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard misconfigured")
	assert.Contains(t, err.Error(), "url missing")
}

// --- parseAPIGuard config parsing ---

func TestParseAPIGuard_MissingURL(t *testing.T) {
	spec := apiGuardSpec(t, map[string]any{})
	guard := parseAPIGuard(context.Background(), nil, "ns", "t", spec)

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard misconfigured")
	assert.Contains(t, err.Error(), "url is required")
}

func TestParseAPIGuard_InvalidURL(t *testing.T) {
	spec := apiGuardSpec(t, map[string]any{"url": "not-a-url"})
	guard := parseAPIGuard(context.Background(), nil, "ns", "t", spec)

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard misconfigured")
	assert.Contains(t, err.Error(), "invalid url")
}

func TestParseAPIGuard_NonHTTPScheme(t *testing.T) {
	spec := apiGuardSpec(t, map[string]any{"url": "ftp://example.com/check"})
	guard := parseAPIGuard(context.Background(), nil, "ns", "t", spec)

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard misconfigured")
	assert.Contains(t, err.Error(), "invalid url")
}

func TestParseAPIGuard_NegativeTimeout(t *testing.T) {
	spec := apiGuardSpec(t, map[string]any{
		"url":       "https://guard.example/check",
		"timeoutMs": -1,
	})
	guard := parseAPIGuard(context.Background(), nil, "ns", "t", spec)

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard misconfigured")
	assert.Contains(t, err.Error(), "timeoutMs")
}

func TestParseAPIGuard_PartialSecretRef(t *testing.T) {
	spec := apiGuardSpec(t, map[string]any{
		"url":       "https://guard.example/check",
		"secretRef": map[string]any{"name": "only-name"},
	})
	guard := parseAPIGuard(context.Background(), nil, "ns", "t", spec)

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard misconfigured")
	assert.Contains(t, err.Error(), "secretRef")
}

func TestParseAPIGuard_ValidWithoutSecretRef(t *testing.T) {
	spec := apiGuardSpec(t, map[string]any{
		"url":       "https://guard.example/check",
		"timeoutMs": 500,
	})
	guard := parseAPIGuard(context.Background(), nil, "ns", "trig", spec)

	assert.Equal(t, "", guard.misconfigured)
	assert.Equal(t, "https://guard.example/check", guard.url)
	assert.Equal(t, 500*time.Millisecond, guard.timeout)
	assert.Equal(t, "trig", guard.triggerName)
	assert.Empty(t, guard.token)
}

func TestParseAPIGuard_LoadsTokenFromSecret(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "guard-token", Namespace: "ns"},
		Data:       map[string][]byte{"token": []byte("s3cret")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()

	spec := apiGuardSpec(t, map[string]any{
		"url": "https://guard.example/check",
		"secretRef": map[string]any{
			"name": "guard-token",
			"key":  "token",
		},
	})
	guard := parseAPIGuard(context.Background(), k8sClient, "ns", "trig", spec)

	assert.Equal(t, "", guard.misconfigured)
	assert.Equal(t, "s3cret", guard.token)
}

func TestParseAPIGuard_SecretNotFound(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()

	spec := apiGuardSpec(t, map[string]any{
		"url": "https://guard.example/check",
		"secretRef": map[string]any{
			"name": "missing-secret",
			"key":  "token",
		},
	})
	guard := parseAPIGuard(context.Background(), k8sClient, "ns", "trig", spec)

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard misconfigured")
	assert.Contains(t, err.Error(), "guard secret unavailable")
}

func TestParseAPIGuard_SecretKeyMissing(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "guard-token", Namespace: "ns"},
		Data:       map[string][]byte{"different-key": []byte("s3cret")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()

	spec := apiGuardSpec(t, map[string]any{
		"url": "https://guard.example/check",
		"secretRef": map[string]any{
			"name": "guard-token",
			"key":  "token",
		},
	})
	guard := parseAPIGuard(context.Background(), k8sClient, "ns", "trig", spec)

	err := guard.Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "guard secret unavailable")
}

// --- buildGuards wiring ---

func TestBuildGuards_WiresAPIGuard(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "guard-token", Namespace: "ns"},
		Data:       map[string][]byte{"token": []byte("s3cret")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()

	gw := NewGateway(k8sClient, "ns", nil)

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "trig", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "webhook",
			WorkloadRef: "wl",
			Guards: []v1alpha1.TriggerGuard{
				apiGuardSpec(t, map[string]any{
					"url": "https://guard.example/check",
					"secretRef": map[string]any{
						"name": "guard-token",
						"key":  "token",
					},
				}),
			},
		},
	}

	guards := gw.buildGuards(context.Background(), trigger)
	require.Len(t, guards, 1)
	apiGuard, ok := guards[0].(*APIGuard)
	require.True(t, ok, "expected *APIGuard, got %T", guards[0])
	assert.Equal(t, "s3cret", apiGuard.token)
	assert.Equal(t, "trig", apiGuard.triggerName)
}

func TestBuildGuards_APIGuardEndToEnd(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":false,"reason":"nope"}`))
	}))
	defer server.Close()

	k8sClient := fake.NewClientBuilder().Build()
	gw := NewGateway(k8sClient, "ns", nil)

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "trig", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "webhook",
			WorkloadRef: "wl",
			Guards: []v1alpha1.TriggerGuard{
				apiGuardSpec(t, map[string]any{"url": server.URL}),
			},
		},
	}

	guards := gw.buildGuards(context.Background(), trigger)
	require.Len(t, guards, 1)

	err := guards[0].Check(context.Background(), "acme", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nope")
}
