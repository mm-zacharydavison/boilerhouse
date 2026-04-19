package trigger

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- Parsing tests ---

func TestTelegramAdapter_ParsesMessageUpdate(t *testing.T) {
	updateJSON := `{
		"update_id": 42,
		"message": {
			"message_id": 7,
			"text": "hello world",
			"chat": {"id": 111},
			"from": {
				"id": 222,
				"first_name": "Jane",
				"last_name": "Doe",
				"username": "janedoe"
			}
		}
	}`

	var update map[string]any
	require.NoError(t, json.Unmarshal([]byte(updateJSON), &update))

	parsed := parseTelegramUpdate(update)
	require.NotNil(t, parsed)
	assert.Equal(t, "message", parsed.UpdateType)
	assert.Equal(t, int64(42), parsed.UpdateID)
	require.NotNil(t, parsed.ChatID)
	assert.Equal(t, int64(111), *parsed.ChatID)
	require.NotNil(t, parsed.UserID)
	assert.Equal(t, int64(222), *parsed.UserID)
	assert.Equal(t, "hello world", parsed.Text)
	assert.Equal(t, "Jane Doe", parsed.SenderName)
	assert.Equal(t, "janedoe", parsed.SenderUsername)

	payload := telegramUpdateToPayload(parsed, update)
	assert.Equal(t, "hello world", payload.Text)
	assert.Equal(t, "telegram", payload.Source)

	rawMap, ok := payload.Raw.(map[string]any)
	require.True(t, ok, "payload.Raw should be a map")
	assert.Equal(t, "janedoe", rawMap["usernameOrId"])
	assert.Equal(t, "janedoe", rawMap["username"])
	assert.Equal(t, "message", rawMap["updateType"])
	// Preserves raw fields.
	_, hasOriginalMessage := rawMap["message"]
	assert.True(t, hasOriginalMessage)
}

func TestTelegramAdapter_ParsesCallbackQuery(t *testing.T) {
	updateJSON := `{
		"update_id": 99,
		"callback_query": {
			"id": "cbq-1",
			"data": "button_value",
			"from": {
				"id": 333,
				"first_name": "John"
			},
			"message": {
				"chat": {"id": 444}
			}
		}
	}`

	var update map[string]any
	require.NoError(t, json.Unmarshal([]byte(updateJSON), &update))

	parsed := parseTelegramUpdate(update)
	require.NotNil(t, parsed)
	assert.Equal(t, "callback_query", parsed.UpdateType)
	assert.Equal(t, int64(99), parsed.UpdateID)
	require.NotNil(t, parsed.ChatID)
	assert.Equal(t, int64(444), *parsed.ChatID)
	require.NotNil(t, parsed.UserID)
	assert.Equal(t, int64(333), *parsed.UserID)
	assert.Equal(t, "button_value", parsed.Text)
	assert.Equal(t, "John", parsed.SenderName)
	assert.Equal(t, "", parsed.SenderUsername)

	payload := telegramUpdateToPayload(parsed, update)
	assert.Equal(t, "button_value", payload.Text)
	assert.Equal(t, "telegram", payload.Source)

	rawMap, ok := payload.Raw.(map[string]any)
	require.True(t, ok)
	// Fallback to user id since there is no username.
	assert.Equal(t, "333", rawMap["usernameOrId"])
}

func TestTelegramAdapter_ParsesEditedMessage(t *testing.T) {
	updateJSON := `{
		"update_id": 10,
		"edited_message": {
			"text": "edited text",
			"chat": {"id": 555},
			"from": {"id": 666, "username": "user666"}
		}
	}`
	var update map[string]any
	require.NoError(t, json.Unmarshal([]byte(updateJSON), &update))

	parsed := parseTelegramUpdate(update)
	require.NotNil(t, parsed)
	assert.Equal(t, "edited_message", parsed.UpdateType)
	assert.Equal(t, "edited text", parsed.Text)
	require.NotNil(t, parsed.ChatID)
	assert.Equal(t, int64(555), *parsed.ChatID)
}

func TestTelegramAdapter_IgnoresUnknownUpdateType(t *testing.T) {
	updateJSON := `{
		"update_id": 1,
		"channel_post": {"text": "hi"}
	}`
	var update map[string]any
	require.NoError(t, json.Unmarshal([]byte(updateJSON), &update))

	parsed := parseTelegramUpdate(update)
	assert.Nil(t, parsed, "unrecognized update type should return nil")
}

func TestTelegramAdapter_ParsesConfig(t *testing.T) {
	cfg, err := parseTelegramConfig(map[string]any{
		"botToken":           "123:abc",
		"apiBaseUrl":         "http://localhost:8080",
		"pollTimeoutSeconds": float64(5),
		"updateTypes":        []any{"message", "callback_query"},
	})
	require.NoError(t, err)
	assert.Equal(t, "123:abc", cfg.BotToken)
	assert.Equal(t, "http://localhost:8080", cfg.APIBaseURL)
	assert.Equal(t, 5, cfg.PollTimeoutSeconds)
	assert.Equal(t, []string{"message", "callback_query"}, cfg.UpdateTypes)
}

func TestTelegramAdapter_RequiresBotToken(t *testing.T) {
	_, err := parseTelegramConfig(map[string]any{})
	assert.Error(t, err)
}

func TestTelegramAdapter_RejectsBothTokenAndSecretRef(t *testing.T) {
	_, err := parseTelegramConfig(map[string]any{
		"botToken":          "literal",
		"botTokenSecretRef": map[string]any{"name": "s", "key": "token"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "mutually exclusive")
}

func TestTelegramAdapter_ParsesSecretRef(t *testing.T) {
	cfg, err := parseTelegramConfig(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "tg-secret", "key": "token"},
	})
	require.NoError(t, err)
	require.NotNil(t, cfg.BotTokenSecretRef)
	assert.Equal(t, "tg-secret", cfg.BotTokenSecretRef.Name)
	assert.Equal(t, "token", cfg.BotTokenSecretRef.Key)
	assert.Empty(t, cfg.BotToken)
}

func TestTelegramAdapter_SecretRefMissingFields(t *testing.T) {
	_, err := parseTelegramConfig(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "s"}, // missing key
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "name and key")
}

// --- Lifecycle test ---

// TestTelegramAdapter_StartStop verifies the adapter calls getMe, polls
// getUpdates, and can be cleanly stopped.
func TestTelegramAdapter_StartStop(t *testing.T) {
	var (
		getMeCalls      atomic.Int64
		deleteHookCalls atomic.Int64
		getUpdatesCalls atomic.Int64
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/getMe"):
			getMeCalls.Add(1)
			_, _ = w.Write([]byte(`{"ok":true,"result":{"id":1,"username":"testbot"}}`))
		case strings.HasSuffix(r.URL.Path, "/deleteWebhook"):
			deleteHookCalls.Add(1)
			_, _ = w.Write([]byte(`{"ok":true}`))
		case strings.HasSuffix(r.URL.Path, "/getUpdates"):
			getUpdatesCalls.Add(1)
			// Respond quickly with no updates so the loop iterates.
			_, _ = w.Write([]byte(`{"ok":true,"result":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	adapter := NewTelegramAdapter(map[string]any{
		"botToken":           "testtoken",
		"apiBaseUrl":         server.URL,
		"pollTimeoutSeconds": float64(0),
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	handler := func(_ context.Context, _ TriggerPayload) (any, error) {
		return nil, nil
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- adapter.Start(ctx, handler)
	}()

	// Wait for getMe and at least one getUpdates poll.
	require.Eventually(t, func() bool {
		return getMeCalls.Load() >= 1 && getUpdatesCalls.Load() >= 1
	}, 5*time.Second, 20*time.Millisecond, "expected getMe and getUpdates to be called")

	assert.GreaterOrEqual(t, deleteHookCalls.Load(), int64(1), "deleteWebhook should be called")

	// Stop and verify the loop exits.
	stopDone := make(chan error, 1)
	go func() {
		stopDone <- adapter.Stop()
	}()

	select {
	case err := <-stopDone:
		assert.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("adapter.Stop did not return in time")
	}

	select {
	case err := <-errCh:
		assert.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("adapter.Start did not return after Stop")
	}
}

// TestTelegramAdapter_StartWithBadToken verifies that a failed getMe causes
// Start to return without starting the poll loop.
func TestTelegramAdapter_StartWithBadToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/getMe") {
			_, _ = w.Write([]byte(`{"ok":false,"description":"Unauthorized"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	adapter := NewTelegramAdapter(map[string]any{
		"botToken":   "bad",
		"apiBaseUrl": server.URL,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- adapter.Start(ctx, func(_ context.Context, _ TriggerPayload) (any, error) { return nil, nil })
	}()

	select {
	case err := <-done:
		assert.NoError(t, err, "Start should return nil (not block) when getMe fails")
	case <-time.After(3 * time.Second):
		t.Fatal("Start did not return after getMe failure")
	}
}
