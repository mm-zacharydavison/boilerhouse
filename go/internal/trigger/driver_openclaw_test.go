package trigger

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func openclawDelta(text string) string {
	b, _ := json.Marshal(map[string]any{
		"choices": []any{
			map[string]any{"delta": map[string]any{"content": text}},
		},
	})
	return string(b)
}

func openclawWriteSSE(w http.ResponseWriter, chunks []string) {
	flusher := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for _, c := range chunks {
		fmt.Fprintf(w, "data: %s\n\n", c)
		flusher.Flush()
	}
	fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func TestOpenclawDriver_Success(t *testing.T) {
	var (
		gotAuth, gotSession, gotPath string
		gotBody                      map[string]any
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotSession = r.Header.Get("X-OpenClaw-Session-Key")
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		openclawWriteSSE(w, []string{openclawDelta("he"), openclawDelta("llo"), "{malformed}"})
	}))
	defer srv.Close()

	d := NewOpenclawDriver("sek")
	result, err := d.Send(context.Background(), srv.URL, "tg-alice", TriggerPayload{Text: "hi"})
	require.NoError(t, err)

	m := result.(map[string]any)
	assert.Equal(t, "hello", m["text"])
	assert.Equal(t, "/v1/chat/completions", gotPath)
	assert.Equal(t, "Bearer sek", gotAuth)
	assert.Equal(t, "tg-alice", gotSession)
	assert.Equal(t, "openclaw", gotBody["model"])
	messages := gotBody["messages"].([]any)
	require.Len(t, messages, 1)
	msg := messages[0].(map[string]any)
	assert.Equal(t, "user", msg["role"])
	assert.Equal(t, "hi", msg["content"])
	assert.Equal(t, true, gotBody["stream"])
}

func TestOpenclawDriver_MissingGatewayToken(t *testing.T) {
	d := NewOpenclawDriver("")
	_, err := d.Send(context.Background(), "http://unused", "t", TriggerPayload{Text: "hi"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "gatewayToken")
}

func TestOpenclawDriver_NonOKResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "bad", http.StatusBadGateway)
	}))
	defer srv.Close()

	d := NewOpenclawDriver("x")
	_, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{}, )
	require.Error(t, err)
	assert.Contains(t, err.Error(), "502")
}

func TestOpenclawDriver_EmptyStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		openclawWriteSSE(w, nil)
	}))
	defer srv.Close()

	d := NewOpenclawDriver("x")
	result, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{})
	require.NoError(t, err)
	assert.Equal(t, "", result.(map[string]any)["text"])
}
