package trigger

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSendReply_NilContextIsNoop(t *testing.T) {
	require.NoError(t, SendReply(context.Background(), nil, "anything"))
}

func TestSendReply_EmptyTextIsNoop(t *testing.T) {
	rc := &ReplyContext{Adapter: "telegram", Config: json.RawMessage(`{"chatId":42,"botToken":"tok"}`)}
	require.NoError(t, SendReply(context.Background(), rc, ""))
}

func TestSendReply_UnsupportedAdapterErrors(t *testing.T) {
	rc := &ReplyContext{Adapter: "carrier-pigeon"}
	err := SendReply(context.Background(), rc, "hello")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported adapter")
}

func TestParseReplyContext_Present(t *testing.T) {
	raw := []byte(`{"interval":"5m","replyContext":{"adapter":"telegram","config":{"chatId":42,"botToken":"tok"}}}`)
	rc := parseReplyContext(raw)
	require.NotNil(t, rc)
	assert.Equal(t, "telegram", rc.Adapter)

	var cfg telegramReplyConfig
	require.NoError(t, json.Unmarshal(rc.Config, &cfg))
	require.NotNil(t, cfg.ChatID)
	assert.Equal(t, int64(42), *cfg.ChatID)
	assert.Equal(t, "tok", cfg.BotToken)
}

func TestParseReplyContext_AbsentOrMalformed(t *testing.T) {
	assert.Nil(t, parseReplyContext(nil))
	assert.Nil(t, parseReplyContext([]byte(`{}`)))
	assert.Nil(t, parseReplyContext([]byte(`not json`)))
}
