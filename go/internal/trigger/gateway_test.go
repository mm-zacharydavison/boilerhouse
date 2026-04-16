package trigger

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- Guard tests ---

func TestAllowlistGuard_AllowsKnownTenant(t *testing.T) {
	guard := &AllowlistGuard{
		TenantIds:   []string{"tenant-1", "tenant-2", "tenant-3"},
		DenyMessage: "not allowed",
	}

	err := guard.Check(context.Background(), "tenant-2", TriggerPayload{})
	assert.NoError(t, err)
}

func TestAllowlistGuard_DeniesUnknownTenant(t *testing.T) {
	guard := &AllowlistGuard{
		TenantIds:   []string{"tenant-1", "tenant-2"},
		DenyMessage: "access denied",
	}

	err := guard.Check(context.Background(), "tenant-99", TriggerPayload{})
	assert.Error(t, err)
	assert.Equal(t, "access denied", err.Error())
}

func TestAllowlistGuard_DeniesWithDefaultMessage(t *testing.T) {
	guard := &AllowlistGuard{
		TenantIds: []string{"tenant-1"},
	}

	err := guard.Check(context.Background(), "unknown", TriggerPayload{})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown")
	assert.Contains(t, err.Error(), "not allowed")
}

func TestAllowlistGuard_EmptyList(t *testing.T) {
	guard := &AllowlistGuard{
		TenantIds:   nil,
		DenyMessage: "nobody allowed",
	}

	err := guard.Check(context.Background(), "any", TriggerPayload{})
	assert.Error(t, err)
}

// --- Tenant resolution tests ---

func TestResolveTenantId_Static(t *testing.T) {
	tenant := &v1alpha1.TriggerTenant{
		Static: "my-tenant",
	}

	id, err := ResolveTenantId(tenant, TriggerPayload{})
	require.NoError(t, err)
	assert.Equal(t, "my-tenant", id)
}

func TestResolveTenantId_StaticWithPrefix(t *testing.T) {
	tenant := &v1alpha1.TriggerTenant{
		Static: "my-tenant",
		Prefix: "org-",
	}

	id, err := ResolveTenantId(tenant, TriggerPayload{})
	require.NoError(t, err)
	assert.Equal(t, "org-my-tenant", id)
}

func TestResolveTenantId_FromField(t *testing.T) {
	tenant := &v1alpha1.TriggerTenant{
		From:   "user_id",
		Prefix: "slack-",
	}

	payload := TriggerPayload{
		Source: "webhook",
		Raw:    map[string]any{"user_id": "U12345", "channel": "C001"},
	}

	id, err := ResolveTenantId(tenant, payload)
	require.NoError(t, err)
	assert.Equal(t, "slack-U12345", id)
}

func TestResolveTenantId_FromFieldNoPefix(t *testing.T) {
	tenant := &v1alpha1.TriggerTenant{
		From: "team_id",
	}

	payload := TriggerPayload{
		Raw: map[string]any{"team_id": "T999"},
	}

	id, err := ResolveTenantId(tenant, payload)
	require.NoError(t, err)
	assert.Equal(t, "T999", id)
}

func TestResolveTenantId_MissingField(t *testing.T) {
	tenant := &v1alpha1.TriggerTenant{
		From: "missing_field",
	}

	payload := TriggerPayload{
		Raw: map[string]any{"other_field": "value"},
	}

	_, err := ResolveTenantId(tenant, payload)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "missing_field")
}

func TestResolveTenantId_NilTenant(t *testing.T) {
	_, err := ResolveTenantId(nil, TriggerPayload{})
	assert.Error(t, err)
}

func TestResolveTenantId_RawNotMap(t *testing.T) {
	tenant := &v1alpha1.TriggerTenant{
		From: "user_id",
	}

	payload := TriggerPayload{
		Raw: "just a string",
	}

	_, err := ResolveTenantId(tenant, payload)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not an object")
}

// --- Webhook adapter tests ---

func TestWebhookAdapter_ReceivesEvent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	adapter := NewWebhookAdapter("/test-hook", "127.0.0.1:0")

	received := make(chan TriggerPayload, 1)
	handler := func(_ context.Context, payload TriggerPayload) (any, error) {
		received <- payload
		return map[string]string{"status": "ok"}, nil
	}

	// Start adapter in background.
	errCh := make(chan error, 1)
	go func() {
		errCh <- adapter.Start(ctx, handler)
	}()

	// Wait for the server to be ready.
	require.Eventually(t, func() bool {
		return adapter.BoundAddr() != ""
	}, 2*time.Second, 10*time.Millisecond, "adapter should bind to an address")

	// POST to the webhook.
	url := "http://" + adapter.BoundAddr() + "/test-hook"
	body := `{"message":"hello","user":"U001"}`
	resp, err := http.Post(url, "application/json", bytes.NewBufferString(body))
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	// Verify the response body.
	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Contains(t, string(respBody), "ok")

	// Verify the handler received the correct payload.
	select {
	case p := <-received:
		assert.Equal(t, "webhook", p.Source)
		rawMap, ok := p.Raw.(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "hello", rawMap["message"])
		assert.Equal(t, "U001", rawMap["user"])
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for handler to receive event")
	}

	// Clean up.
	cancel()
	select {
	case err := <-errCh:
		assert.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for adapter to stop")
	}
}

func TestWebhookAdapter_RejectsNonPost(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	adapter := NewWebhookAdapter("/hook", "127.0.0.1:0")

	handler := func(_ context.Context, payload TriggerPayload) (any, error) {
		t.Fatal("handler should not be called for GET requests")
		return nil, nil
	}

	go func() {
		_ = adapter.Start(ctx, handler)
	}()

	require.Eventually(t, func() bool {
		return adapter.BoundAddr() != ""
	}, 2*time.Second, 10*time.Millisecond)

	resp, err := http.Get("http://" + adapter.BoundAddr() + "/hook")
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
}

// --- DefaultDriver tests ---

func TestDefaultDriver_SendsPayload(t *testing.T) {
	var receivedPayload TriggerPayload

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)

		err = json.Unmarshal(body, &receivedPayload)
		require.NoError(t, err)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"received":true}`))
	}))
	defer server.Close()

	driver := NewDefaultDriver(server.Client())
	payload := TriggerPayload{
		Text:   "hello world",
		Source: "webhook",
		Raw:    map[string]any{"key": "value"},
	}

	result, err := driver.Send(context.Background(), server.URL, payload)
	require.NoError(t, err)

	// Verify the driver received the correct payload.
	assert.Equal(t, "hello world", receivedPayload.Text)
	assert.Equal(t, "webhook", receivedPayload.Source)

	// Verify the response was parsed.
	resultMap, ok := result.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, true, resultMap["received"])
}

func TestDefaultDriver_HandlesErrorResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer server.Close()

	driver := NewDefaultDriver(server.Client())
	payload := TriggerPayload{Source: "webhook"}

	_, err := driver.Send(context.Background(), server.URL, payload)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "500")
}

// --- CronAdapter tests ---

func TestCronAdapter_FiresEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	adapter := NewCronAdapter(50*time.Millisecond, "tick-payload")

	received := make(chan TriggerPayload, 10)
	handler := func(_ context.Context, payload TriggerPayload) (any, error) {
		received <- payload
		return nil, nil
	}

	go func() {
		_ = adapter.Start(ctx, handler)
	}()

	// Wait for at least 2 ticks.
	var payloads []TriggerPayload
	timeout := time.After(500 * time.Millisecond)
	for len(payloads) < 2 {
		select {
		case p := <-received:
			payloads = append(payloads, p)
		case <-timeout:
			t.Fatalf("only received %d events, expected at least 2", len(payloads))
		}
	}

	assert.Equal(t, "cron", payloads[0].Source)
	assert.Equal(t, "tick-payload", payloads[0].Text)

	cancel()
}

func TestCronAdapter_InvalidInterval(t *testing.T) {
	adapter := NewCronAdapter(0, "payload")
	err := adapter.Start(context.Background(), func(_ context.Context, _ TriggerPayload) (any, error) {
		return nil, nil
	})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "positive")
}

// --- Config parsing tests ---

func TestFormatEndpoint(t *testing.T) {
	tests := []struct {
		name     string
		endpoint *v1alpha1.ClaimEndpoint
		want     string
	}{
		{
			name:     "with port",
			endpoint: &v1alpha1.ClaimEndpoint{Host: "10.0.0.1", Port: 8080},
			want:     "http://10.0.0.1:8080",
		},
		{
			name:     "without port",
			endpoint: &v1alpha1.ClaimEndpoint{Host: "10.0.0.1"},
			want:     "http://10.0.0.1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatEndpoint(tt.endpoint)
			assert.Equal(t, tt.want, got)
		})
	}
}
