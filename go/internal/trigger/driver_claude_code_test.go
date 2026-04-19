package trigger

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type bridgeBehavior struct {
	skipReady bool
	output    []string
	final     string // "idle", "exit", or "" (hang)
	exitCode  int
	stderr    string
}

func startFakeBridge(t *testing.T, behavior bridgeBehavior) *httptest.Server {
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
		assert.Equal(t, "init", msg["type"])
		assert.NotEmpty(t, msg["tenantId"])

		if behavior.skipReady {
			time.Sleep(5 * time.Second)
			return
		}
		_ = conn.WriteJSON(map[string]any{"type": "ready"})

		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		assert.Equal(t, "prompt", msg["type"])

		for _, chunk := range behavior.output {
			_ = conn.WriteJSON(map[string]any{"type": "output", "text": chunk})
		}
		switch behavior.final {
		case "idle":
			_ = conn.WriteJSON(map[string]any{"type": "idle"})
		case "exit":
			_ = conn.WriteJSON(map[string]any{"type": "exit", "code": behavior.exitCode, "stderr": behavior.stderr})
		}
	})
	return httptest.NewServer(mux)
}

func TestClaudeCodeDriver_Success(t *testing.T) {
	srv := startFakeBridge(t, bridgeBehavior{output: []string{"hel", "lo"}, final: "idle"})
	defer srv.Close()

	d := &ClaudeCodeDriver{handshakeTimeout: 2 * time.Second, overallTimeout: 5 * time.Second}
	result, err := d.Send(context.Background(), srv.URL, "tg-alice", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	m, ok := result.(map[string]any)
	require.True(t, ok, "expected map result, got %T", result)
	assert.Equal(t, "hello", m["text"])
}

func TestClaudeCodeDriver_ExitWithEmptyOutput(t *testing.T) {
	srv := startFakeBridge(t, bridgeBehavior{final: "exit", exitCode: 2, stderr: "boom"})
	defer srv.Close()

	d := &ClaudeCodeDriver{handshakeTimeout: 2 * time.Second, overallTimeout: 5 * time.Second}
	result, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	m := result.(map[string]any)
	text := m["text"].(string)
	assert.Contains(t, text, "exited with code 2")
	assert.Contains(t, text, "boom")
}

func TestClaudeCodeDriver_ExitAfterOutputPrefersText(t *testing.T) {
	srv := startFakeBridge(t, bridgeBehavior{output: []string{"partial"}, final: "exit", exitCode: 1})
	defer srv.Close()

	d := &ClaudeCodeDriver{handshakeTimeout: 2 * time.Second, overallTimeout: 5 * time.Second}
	result, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	m := result.(map[string]any)
	assert.Equal(t, "partial", m["text"])
}

func TestClaudeCodeDriver_HandshakeTimeout(t *testing.T) {
	srv := startFakeBridge(t, bridgeBehavior{skipReady: true})
	defer srv.Close()

	d := &ClaudeCodeDriver{handshakeTimeout: 100 * time.Millisecond, overallTimeout: 5 * time.Second}
	_, err := d.Send(context.Background(), srv.URL, "t", TriggerPayload{Text: "hi"})
	require.Error(t, err)
	assert.Contains(t, strings.ToLower(err.Error()), "handshake")
}

func TestClaudeCodeDriver_ConnectionRefused(t *testing.T) {
	d := &ClaudeCodeDriver{handshakeTimeout: 500 * time.Millisecond, overallTimeout: 2 * time.Second}
	_, err := d.Send(context.Background(), "http://127.0.0.1:1", "t", TriggerPayload{Text: "hi"})
	require.Error(t, err)
}

func TestClaudeCodeDriver_SendsTenantIdInInit(t *testing.T) {
	var gotTenantId string
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var msg map[string]any
		_ = conn.ReadJSON(&msg)
		gotTenantId, _ = msg["tenantId"].(string)
		_ = conn.WriteJSON(map[string]any{"type": "ready"})
		_ = conn.ReadJSON(&msg) // prompt
		_ = conn.WriteJSON(map[string]any{"type": "idle"})
	}))
	defer srv.Close()

	d := &ClaudeCodeDriver{handshakeTimeout: 2 * time.Second, overallTimeout: 5 * time.Second}
	_, err := d.Send(context.Background(), srv.URL, "tg-alice", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	assert.Equal(t, "tg-alice", gotTenantId)
}
