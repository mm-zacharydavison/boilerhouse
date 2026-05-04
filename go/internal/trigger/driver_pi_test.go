package trigger

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func startFakePiBridge(t *testing.T, output []string, final string, exitCode int) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		assert.Equal(t, "prompt", msg["type"])

		for _, chunk := range output {
			_ = conn.WriteJSON(map[string]any{"type": "output", "text": chunk})
		}
		switch final {
		case "idle":
			_ = conn.WriteJSON(map[string]any{"type": "idle"})
		case "exit":
			_ = conn.WriteJSON(map[string]any{"type": "exit", "code": exitCode})
		case "error":
			_ = conn.WriteJSON(map[string]any{"type": "error", "message": "something went wrong"})
		}
	})
	return httptest.NewServer(mux)
}

func TestPiDriver_Success(t *testing.T) {
	srv := startFakePiBridge(t, []string{"hel", "lo"}, "idle", 0)
	defer srv.Close()

	d := &PiDriver{overallTimeout: 5 * time.Second}
	result, err := d.Send(context.Background(), srv.URL, "tg-alice", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	m, ok := result.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "hello", m["text"])
}

func TestPiDriver_ExitWithOutput(t *testing.T) {
	srv := startFakePiBridge(t, []string{"partial"}, "exit", 1)
	defer srv.Close()

	d := &PiDriver{overallTimeout: 5 * time.Second}
	result, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	m := result.(map[string]any)
	assert.Equal(t, "partial", m["text"])
}

func TestPiDriver_ExitWithNoOutput(t *testing.T) {
	srv := startFakePiBridge(t, nil, "exit", 2)
	defer srv.Close()

	d := &PiDriver{overallTimeout: 5 * time.Second}
	result, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	m := result.(map[string]any)
	assert.Contains(t, m["text"], "exited with code 2")
}

func TestPiDriver_BridgeError(t *testing.T) {
	srv := startFakePiBridge(t, nil, "error", 0)
	defer srv.Close()

	d := &PiDriver{overallTimeout: 5 * time.Second}
	_, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{Text: "hi"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "bridge error")
	assert.Contains(t, err.Error(), "something went wrong")
}

func TestPiDriver_ConnectionRefused(t *testing.T) {
	d := &PiDriver{overallTimeout: 2 * time.Second}
	_, err := d.Send(context.Background(), "http://127.0.0.1:1", "t", TriggerPayload{Text: "hi"})
	require.Error(t, err)
}

func TestPiDriver_NoInitHandshake(t *testing.T) {
	// Verify Pi driver does NOT send an init message before the prompt.
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var firstMsgType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var msg map[string]any
		_ = conn.ReadJSON(&msg)
		firstMsgType, _ = msg["type"].(string)
		_ = conn.WriteJSON(map[string]any{"type": "idle"})
	}))
	defer srv.Close()

	d := &PiDriver{overallTimeout: 5 * time.Second}
	_, _ = d.Send(context.Background(), srv.URL, "t", TriggerPayload{Text: "hi"})
	assert.Equal(t, "prompt", firstMsgType)
}
