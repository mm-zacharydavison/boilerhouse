package trigger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ReplyContext describes how to deliver a trigger's response back to the
// channel that originated the session. Cron and one-shot adapters can fire
// without an inbound channel of their own — the firing handler reads this
// context off the trigger's spec.config.replyContext and uses it to fan the
// driver's response back to (e.g.) Telegram.
type ReplyContext struct {
	Adapter    string `json:"adapter"`
	ChatID     *int64 `json:"chatId,omitempty"`
	BotToken   string `json:"botToken,omitempty"`
	APIBaseURL string `json:"apiBaseUrl,omitempty"`
}

// replyHTTPClient is package-private so tests can override timeouts. Defaults
// to a generous 30s — Telegram occasionally takes seconds to respond.
var replyHTTPClient = &http.Client{Timeout: 30 * time.Second}

// SendReply delivers the driver's response back to the originating channel,
// if a ReplyContext is provided. nil rc is a no-op (admin triggers without a
// reply channel, dev environments, etc.). Empty response text is also a
// no-op — drivers that intentionally produce no text shouldn't trigger noise.
func SendReply(ctx context.Context, rc *ReplyContext, response any) error {
	if rc == nil {
		return nil
	}
	text := extractResponseText(response)
	if text == "" {
		return nil
	}
	switch rc.Adapter {
	case "telegram":
		if rc.ChatID == nil {
			return fmt.Errorf("reply: telegram requires chatId")
		}
		if rc.BotToken == "" {
			return fmt.Errorf("reply: telegram requires botToken")
		}
		base := rc.APIBaseURL
		if base == "" {
			base = defaultTelegramAPIBaseURL
		}
		return sendTelegramMessageRaw(ctx, base, rc.BotToken, *rc.ChatID, text)
	default:
		return fmt.Errorf("reply: unsupported adapter %q", rc.Adapter)
	}
}

// sendTelegramMessageRaw posts a message to Telegram without holding any
// adapter state. Mirrors TelegramAdapter.sendMessage but is callable from the
// reply path which has no live adapter.
func sendTelegramMessageRaw(ctx context.Context, apiBaseURL, botToken string, chatID int64, text string) error {
	body, err := json.Marshal(map[string]any{
		"chat_id": chatID,
		"text":    text,
	})
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/bot%s/sendMessage", apiBaseURL, botToken)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := replyHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("reply: telegram sendMessage status %d", resp.StatusCode)
	}
	return nil
}

// parseReplyContext extracts a ReplyContext out of a trigger's spec.config
// when present. Returns nil if absent or malformed (non-fatal — adapter still
// fires, just without an outbound reply).
func parseReplyContext(rawConfig []byte) *ReplyContext {
	if len(rawConfig) == 0 {
		return nil
	}
	var wrapper struct {
		ReplyContext *ReplyContext `json:"replyContext"`
	}
	if err := json.Unmarshal(rawConfig, &wrapper); err != nil {
		return nil
	}
	return wrapper.ReplyContext
}
