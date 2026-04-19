package trigger

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// OpenclawDriver POSTs trigger text to <endpoint>/v1/chat/completions with
// Bearer auth and reads the SSE stream, accumulating choices[0].delta.content.
// Session continuity is carried by X-OpenClaw-Session-Key: <tenantId>.
type OpenclawDriver struct {
	GatewayToken string
	HTTPClient   *http.Client
}

// NewOpenclawDriver returns a driver bound to the given gateway token. An
// empty token is accepted at construction time but every Send will fail —
// this keeps the constructor infallible and mirrors misconfiguredDriver's
// per-event error surfacing.
func NewOpenclawDriver(gatewayToken string) *OpenclawDriver {
	return &OpenclawDriver{GatewayToken: gatewayToken}
}

// Send implements Driver.
func (d *OpenclawDriver) Send(ctx context.Context, endpoint, tenantId string, payload TriggerPayload) (any, error) {
	if d.GatewayToken == "" {
		return nil, fmt.Errorf("openclaw: gatewayToken is required")
	}

	body, err := json.Marshal(map[string]any{
		"model":    "openclaw",
		"messages": []map[string]string{{"role": "user", "content": payload.Text}},
		"stream":   true,
	})
	if err != nil {
		return nil, fmt.Errorf("openclaw: marshal: %w", err)
	}

	url := strings.TrimRight(endpoint, "/") + "/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("openclaw: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+d.GatewayToken)
	req.Header.Set("X-OpenClaw-Session-Key", tenantId)

	client := d.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openclaw: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("openclaw: status %d: %s", resp.StatusCode, string(raw))
	}

	var sb strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) > 0 {
			sb.WriteString(chunk.Choices[0].Delta.Content)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("openclaw: read stream: %w", err)
	}

	return map[string]any{"text": sb.String()}, nil
}
