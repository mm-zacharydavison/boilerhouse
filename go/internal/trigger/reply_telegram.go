package trigger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// telegramReplyConfig is the provider-specific config block for
// ReplyContext{Adapter: "telegram"}.
type telegramReplyConfig struct {
	ChatID     *int64 `json:"chatId"`
	BotToken   string `json:"botToken"`
	APIBaseURL string `json:"apiBaseUrl,omitempty"`
}

// telegramReplySender delivers reply text to a Telegram chat.
type telegramReplySender struct {
	apiBaseURL string
	botToken   string
	chatID     int64
}

// newTelegramReplySender builds a ReplySender from a telegram reply config
// block, applying the package's default API base URL when unset.
func newTelegramReplySender(config json.RawMessage) (ReplySender, error) {
	var cfg telegramReplyConfig
	if err := json.Unmarshal(config, &cfg); err != nil {
		return nil, fmt.Errorf("reply: invalid telegram config: %w", err)
	}
	if cfg.ChatID == nil {
		return nil, fmt.Errorf("reply: telegram requires chatId")
	}
	if cfg.BotToken == "" {
		return nil, fmt.Errorf("reply: telegram requires botToken")
	}
	base := cfg.APIBaseURL
	if base == "" {
		base = defaultTelegramAPIBaseURL
	}
	return &telegramReplySender{
		apiBaseURL: base,
		botToken:   cfg.BotToken,
		chatID:     *cfg.ChatID,
	}, nil
}

func (s *telegramReplySender) Send(ctx context.Context, text string) error {
	return sendTelegramMessageRaw(ctx, s.apiBaseURL, s.botToken, s.chatID, text)
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
