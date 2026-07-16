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

func TestSendReply_NilContextIsNoop(t *testing.T) {
	require.NoError(t, SendReply(context.Background(), nil, "anything"))
}

func TestSendReply_EmptyTextIsNoop(t *testing.T) {
	chatID := int64(42)
	rc := &ReplyContext{Adapter: "telegram", ChatID: &chatID, BotToken: "tok"}
	require.NoError(t, SendReply(context.Background(), rc, ""))
}

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

	chatID := int64(42)
	rc := &ReplyContext{
		Adapter:    "telegram",
		ChatID:     &chatID,
		BotToken:   "tok",
		APIBaseURL: srv.URL,
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

	chatID := int64(42)
	rc := &ReplyContext{Adapter: "telegram", ChatID: &chatID, BotToken: "tok", APIBaseURL: srv.URL}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "status 403")
}

func TestSendReply_TelegramMissingChatIDErrors(t *testing.T) {
	rc := &ReplyContext{Adapter: "telegram", BotToken: "tok"}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "chatId")
}

func TestSendReply_TelegramMissingBotTokenErrors(t *testing.T) {
	chatID := int64(42)
	rc := &ReplyContext{Adapter: "telegram", ChatID: &chatID}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "botToken")
}

func TestSendReply_UnsupportedAdapterErrors(t *testing.T) {
	rc := &ReplyContext{Adapter: "carrier-pigeon"}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported adapter")
}

func TestParseReplyContext_Present(t *testing.T) {
	raw := []byte(`{"interval":"5m","replyContext":{"adapter":"telegram","chatId":42,"botToken":"tok"}}`)
	rc := parseReplyContext(raw)
	require.NotNil(t, rc)
	assert.Equal(t, "telegram", rc.Adapter)
	require.NotNil(t, rc.ChatID)
	assert.Equal(t, int64(42), *rc.ChatID)
	assert.Equal(t, "tok", rc.BotToken)
}

func TestParseReplyContext_AbsentOrMalformed(t *testing.T) {
	assert.Nil(t, parseReplyContext(nil))
	assert.Nil(t, parseReplyContext([]byte(`{}`)))
	assert.Nil(t, parseReplyContext([]byte(`not json`)))
}
