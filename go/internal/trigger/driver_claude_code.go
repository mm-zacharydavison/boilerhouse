package trigger

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	claudeCodeDefaultHandshakeTimeout = 10 * time.Second
	claudeCodeDefaultOverallTimeout   = 300 * time.Second
)

// ClaudeCodeDriver dials the workload's /ws bridge and runs the init/prompt
// exchange defined by workloads/claude-code/bridge.mjs:
//
//	→ {type: "init", tenantId}   ← {type: "ready"}
//	→ {type: "prompt", text}
//	← {type: "output", text}     (one or more, accumulated)
//	← {type: "idle"}             (returns accumulated text)
//	← {type: "exit", code, stderr}
type ClaudeCodeDriver struct {
	handshakeTimeout time.Duration
	overallTimeout   time.Duration
}

// NewClaudeCodeDriver returns a driver with the default timeouts.
func NewClaudeCodeDriver() *ClaudeCodeDriver {
	return &ClaudeCodeDriver{
		handshakeTimeout: claudeCodeDefaultHandshakeTimeout,
		overallTimeout:   claudeCodeDefaultOverallTimeout,
	}
}

// Send implements Driver.
func (d *ClaudeCodeDriver) Send(ctx context.Context, endpoint, tenantId string, payload TriggerPayload) (any, error) {
	handshakeTimeout := d.handshakeTimeout
	if handshakeTimeout == 0 {
		handshakeTimeout = claudeCodeDefaultHandshakeTimeout
	}
	overallTimeout := d.overallTimeout
	if overallTimeout == 0 {
		overallTimeout = claudeCodeDefaultOverallTimeout
	}

	ctx, cancel := context.WithTimeout(ctx, overallTimeout)
	defer cancel()

	wsEndpoint := endpointToWS(endpoint)

	dialer := websocket.Dialer{HandshakeTimeout: handshakeTimeout}
	conn, _, err := dialer.DialContext(ctx, wsEndpoint, http.Header{})
	if err != nil {
		return nil, fmt.Errorf("claude-code: dial %s: %w", wsEndpoint, err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{"type": "init", "tenantId": tenantId}); err != nil {
		return nil, fmt.Errorf("claude-code: send init: %w", err)
	}

	if err := claudeCodeWaitForReady(conn, handshakeTimeout); err != nil {
		return nil, err
	}

	if err := conn.WriteJSON(map[string]any{"type": "prompt", "text": payload.Text}); err != nil {
		return nil, fmt.Errorf("claude-code: send prompt: %w", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(overallTimeout))

	var sb strings.Builder
	for {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return nil, fmt.Errorf("claude-code: read: %w", err)
		}
		mtype, _ := msg["type"].(string)
		switch mtype {
		case "output":
			if text, ok := msg["text"].(string); ok {
				sb.WriteString(text)
			}
		case "idle":
			return map[string]any{"text": sb.String()}, nil
		case "exit":
			if sb.Len() > 0 {
				return map[string]any{"text": sb.String()}, nil
			}
			code := 1
			if n, ok := msg["code"].(float64); ok {
				code = int(n)
			}
			stderr, _ := msg["stderr"].(string)
			detail := ""
			if stderr != "" {
				detail = "\n" + stderr
			}
			return map[string]any{"text": fmt.Sprintf("Claude Code exited with code %d%s", code, detail)}, nil
		case "error":
			msgText, _ := msg["message"].(string)
			return nil, fmt.Errorf("claude-code: bridge error: %s", msgText)
		}
	}
}

func claudeCodeWaitForReady(conn *websocket.Conn, timeout time.Duration) error {
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	defer conn.SetReadDeadline(time.Time{})

	for {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return fmt.Errorf("claude-code: handshake: %w", err)
		}
		if t, _ := msg["type"].(string); t == "ready" {
			return nil
		}
	}
}

func endpointToWS(endpoint string) string {
	s := strings.TrimRight(endpoint, "/")
	if strings.HasPrefix(s, "https://") {
		return "wss://" + strings.TrimPrefix(s, "https://") + "/ws"
	}
	if strings.HasPrefix(s, "http://") {
		return "ws://" + strings.TrimPrefix(s, "http://") + "/ws"
	}
	return s + "/ws"
}
