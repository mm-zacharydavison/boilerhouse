package trigger

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSendReply_TelegramDelivers(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	rc := &ReplyContext{
		Adapter: "telegram",
		Config:  json.RawMessage(`{"chatId":42,"botToken":"tok","apiBaseUrl":"` + srv.URL + `"}`),
	}
	require.NoError(t, SendReply(context.Background(), rc, "hello there"))

	assert.Equal(t, "/bottok/sendMessage", gotPath)
	assert.Equal(t, float64(42), gotBody["chat_id"])
	assert.Equal(t, "hello there", gotBody["text"])
}

func TestSendReply_TelegramNon2xxErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	rc := &ReplyContext{
		Adapter: "telegram",
		Config:  json.RawMessage(`{"chatId":42,"botToken":"tok","apiBaseUrl":"` + srv.URL + `"}`),
	}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "status 403")
}

func TestSendReply_TelegramMissingChatIDErrors(t *testing.T) {
	rc := &ReplyContext{Adapter: "telegram", Config: json.RawMessage(`{"botToken":"tok"}`)}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "chatId")
}

func TestSendReply_TelegramMissingBotTokenErrors(t *testing.T) {
	rc := &ReplyContext{Adapter: "telegram", Config: json.RawMessage(`{"chatId":42}`)}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "botToken")
}
