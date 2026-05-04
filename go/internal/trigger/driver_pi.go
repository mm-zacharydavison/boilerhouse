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
	piDefaultOverallTimeout = 300 * time.Second
)

// PiDriver dials the Pi bridge's /ws endpoint and runs the prompt exchange:
//
//	→ {type: "prompt", text}
//	← {type: "output", text}     (one or more, accumulated)
//	← {type: "idle"}             (returns accumulated text)
//	← {type: "exit", code}
//
// Unlike ClaudeCodeDriver there is no init/ready handshake.
type PiDriver struct {
	overallTimeout time.Duration
}

func NewPiDriver() *PiDriver {
	return &PiDriver{overallTimeout: piDefaultOverallTimeout}
}

func (d *PiDriver) Send(ctx context.Context, endpoint, _ string, payload TriggerPayload) (any, error) {
	timeout := d.overallTimeout
	if timeout == 0 {
		timeout = piDefaultOverallTimeout
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	wsEndpoint := endpointToWS(endpoint)

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.DialContext(ctx, wsEndpoint, http.Header{})
	if err != nil {
		return nil, fmt.Errorf("pi: dial %s: %w", wsEndpoint, err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{"type": "prompt", "text": payload.Text}); err != nil {
		return nil, fmt.Errorf("pi: send prompt: %w", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(timeout))

	var sb strings.Builder
	for {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return nil, fmt.Errorf("pi: read: %w", err)
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
			return map[string]any{"text": fmt.Sprintf("Pi exited with code %d", code)}, nil
		case "error":
			msgText, _ := msg["message"].(string)
			return nil, fmt.Errorf("pi: bridge error: %s", msgText)
		}
	}
}
