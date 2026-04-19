package trigger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const (
	defaultTelegramAPIBaseURL    = "https://api.telegram.org"
	defaultTelegramPollTimeout   = 30
	telegramErrorBackoff         = 5 * time.Second
	telegramHTTPClientTimeoutSec = 60
)

// TelegramAdapter long-polls the Telegram Bot API for updates and dispatches
// them through the handler. It follows the same lifecycle as CronAdapter:
// Start blocks until ctx is cancelled, and Stop cancels the internal context
// and waits for the poll loop to exit.
type TelegramAdapter struct {
	config     map[string]any
	handler    EventHandler
	cancel     context.CancelFunc
	doneCh     chan struct{}
	httpClient *http.Client
	log        *slog.Logger
}

// NewTelegramAdapter creates a new TelegramAdapter with the given config map.
func NewTelegramAdapter(config map[string]any) *TelegramAdapter {
	return &TelegramAdapter{
		config:     config,
		httpClient: &http.Client{Timeout: telegramHTTPClientTimeoutSec * time.Second},
		doneCh:     make(chan struct{}),
		log:        slog.Default(),
	}
}

// telegramConfig is the parsed adapter config.
type telegramConfig struct {
	BotToken           string
	BotTokenSecretRef  *telegramSecretRef
	UpdateTypes        []string
	PollTimeoutSeconds int
	APIBaseURL         string
}

// telegramSecretRef points at a Kubernetes Secret key holding the bot token.
type telegramSecretRef struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

func parseTelegramConfig(raw map[string]any) (telegramConfig, error) {
	cfg := telegramConfig{
		UpdateTypes:        []string{"message"},
		PollTimeoutSeconds: defaultTelegramPollTimeout,
		APIBaseURL:         defaultTelegramAPIBaseURL,
	}

	if raw == nil {
		return cfg, fmt.Errorf("telegram adapter: config is required")
	}

	hasLiteral := false
	if v, ok := raw["botToken"].(string); ok && v != "" {
		cfg.BotToken = v
		hasLiteral = true
	}

	hasRef := false
	if v, ok := raw["botTokenSecretRef"].(map[string]any); ok {
		name, _ := v["name"].(string)
		key, _ := v["key"].(string)
		if name == "" || key == "" {
			return cfg, fmt.Errorf("telegram adapter: botTokenSecretRef requires name and key")
		}
		cfg.BotTokenSecretRef = &telegramSecretRef{Name: name, Key: key}
		hasRef = true
	}

	switch {
	case hasLiteral && hasRef:
		return cfg, fmt.Errorf("telegram adapter: botToken and botTokenSecretRef are mutually exclusive")
	case !hasLiteral && !hasRef:
		return cfg, fmt.Errorf("telegram adapter: botToken or botTokenSecretRef is required")
	}

	if v, ok := raw["apiBaseUrl"].(string); ok && v != "" {
		cfg.APIBaseURL = v
	}

	if v, ok := raw["pollTimeoutSeconds"]; ok {
		switch n := v.(type) {
		case int:
			cfg.PollTimeoutSeconds = n
		case int64:
			cfg.PollTimeoutSeconds = int(n)
		case float64:
			cfg.PollTimeoutSeconds = int(n)
		}
	}

	if v, ok := raw["updateTypes"]; ok {
		switch typed := v.(type) {
		case []string:
			if len(typed) > 0 {
				cfg.UpdateTypes = typed
			}
		case []any:
			var types []string
			for _, item := range typed {
				if s, ok := item.(string); ok {
					types = append(types, s)
				}
			}
			if len(types) > 0 {
				cfg.UpdateTypes = types
			}
		}
	}

	return cfg, nil
}

// Start verifies the bot token, clears any existing webhook, and starts the
// long-polling loop. It blocks until the context is cancelled.
func (t *TelegramAdapter) Start(ctx context.Context, handler EventHandler) error {
	cfg, err := parseTelegramConfig(t.config)
	if err != nil {
		return err
	}
	t.handler = handler

	ctx, t.cancel = context.WithCancel(ctx)
	defer func() {
		select {
		case <-t.doneCh:
			// already closed
		default:
			close(t.doneCh)
		}
	}()

	tgAPI := fmt.Sprintf("%s/bot%s", cfg.APIBaseURL, cfg.BotToken)

	// Verify bot token by calling getMe.
	me, err := t.getMe(ctx, tgAPI)
	if err != nil {
		t.log.Error("telegram getMe failed — check botToken", "error", err)
		return nil
	}
	t.log.Info("connected to Telegram", "username", me.Username, "bot_id", me.ID)

	// Clear any existing webhook so long-polling can work.
	if err := t.deleteWebhook(ctx, tgAPI); err != nil {
		t.log.Error("telegram deleteWebhook failed", "error", err)
		// Not fatal — continue.
	}

	t.log.Info("telegram polling started",
		"timeout_seconds", cfg.PollTimeoutSeconds,
		"update_types", cfg.UpdateTypes,
	)

	return t.pollLoop(ctx, cfg, tgAPI)
}

// Stop cancels the poll loop and waits for it to exit.
func (t *TelegramAdapter) Stop() error {
	if t.cancel != nil {
		t.cancel()
	}
	<-t.doneCh
	return nil
}

// pollLoop continuously calls getUpdates until ctx is cancelled.
func (t *TelegramAdapter) pollLoop(ctx context.Context, cfg telegramConfig, tgAPI string) error {
	allowedUpdatesJSON, err := json.Marshal(cfg.UpdateTypes)
	if err != nil {
		return fmt.Errorf("telegram: marshal update types: %w", err)
	}

	offset := int64(0)

	for {
		if ctx.Err() != nil {
			return nil
		}

		pollURL := fmt.Sprintf(
			"%s/getUpdates?timeout=%d&offset=%d&allowed_updates=%s",
			tgAPI,
			cfg.PollTimeoutSeconds,
			offset,
			url.QueryEscape(string(allowedUpdatesJSON)),
		)

		updates, err := t.getUpdates(ctx, pollURL)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			t.log.Error("telegram getUpdates error", "error", err)
			if !telegramBackoff(ctx, telegramErrorBackoff) {
				return nil
			}
			continue
		}

		if len(updates) > 0 {
			t.log.Info("telegram received updates", "count", len(updates))
		}

		for _, update := range updates {
			updateID, _ := getNumber(update["update_id"])
			if int64(updateID) >= offset {
				offset = int64(updateID) + 1
			}

			parsed := parseTelegramUpdate(update)
			if parsed == nil {
				continue
			}
			if !containsString(cfg.UpdateTypes, parsed.UpdateType) {
				continue
			}

			payload := telegramUpdateToPayload(parsed, update)

			result, err := t.handler(ctx, payload)
			if err != nil {
				t.log.Error("telegram handler error", "error", err)
				continue
			}

			// If the handler response contains text and we have a chat id,
			// send it back to the Telegram chat.
			if parsed.ChatID != nil {
				text := extractResponseText(result)
				if text != "" {
					if err := t.sendMessage(ctx, tgAPI, *parsed.ChatID, text); err != nil {
						t.log.Error("telegram sendMessage failed", "error", err, "chat_id", *parsed.ChatID)
					}
				}
			}
		}
	}
}

// telegramBackoff sleeps for the given duration or returns false if ctx is
// cancelled during the sleep.
func telegramBackoff(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// --- Telegram API calls ---

type telegramGetMeResult struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

type telegramGetMeResponse struct {
	OK          bool                `json:"ok"`
	Result      telegramGetMeResult `json:"result"`
	Description string              `json:"description"`
}

func (t *TelegramAdapter) getMe(ctx context.Context, tgAPI string) (*telegramGetMeResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tgAPI+"/getMe", nil)
	if err != nil {
		return nil, err
	}
	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var parsed telegramGetMeResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("telegram getMe: parse body: %w", err)
	}
	if !parsed.OK {
		return nil, fmt.Errorf("telegram getMe: %s", parsed.Description)
	}
	return &parsed.Result, nil
}

func (t *TelegramAdapter) deleteWebhook(ctx context.Context, tgAPI string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tgAPI+"/deleteWebhook", nil)
	if err != nil {
		return err
	}
	resp, err := t.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var parsed struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("telegram deleteWebhook: parse body: %w", err)
	}
	if !parsed.OK {
		return fmt.Errorf("telegram deleteWebhook: %s", parsed.Description)
	}
	return nil
}

func (t *TelegramAdapter) getUpdates(ctx context.Context, pollURL string) ([]map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("telegram getUpdates: status %d: %s", resp.StatusCode, string(body))
	}

	var parsed struct {
		OK          bool             `json:"ok"`
		Result      []map[string]any `json:"result"`
		Description string           `json:"description"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("telegram getUpdates: parse body: %w", err)
	}
	if !parsed.OK {
		return nil, fmt.Errorf("telegram getUpdates: %s", parsed.Description)
	}
	return parsed.Result, nil
}

func (t *TelegramAdapter) sendMessage(ctx context.Context, tgAPI string, chatID int64, text string) error {
	body, err := json.Marshal(map[string]any{
		"chat_id": chatID,
		"text":    text,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tgAPI+"/sendMessage", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram sendMessage: status %d", resp.StatusCode)
	}
	return nil
}

// --- Parsing ---

// parsedTelegramUpdate contains the normalized fields we extract from a Telegram
// update. ChatID / UserID are pointers so callers can distinguish "missing"
// from "zero".
type parsedTelegramUpdate struct {
	UpdateType     string
	UpdateID       int64
	ChatID         *int64
	UserID         *int64
	Text           string
	SenderName     string
	SenderUsername string
}

// parseTelegramUpdate extracts fields from a raw Telegram update. Returns nil
// if the update type is unrecognized.
func parseTelegramUpdate(update map[string]any) *parsedTelegramUpdate {
	if update == nil {
		return nil
	}

	var updateType string
	var msg map[string]any
	var cb map[string]any

	if m, ok := update["message"].(map[string]any); ok {
		updateType = "message"
		msg = m
	} else if m, ok := update["edited_message"].(map[string]any); ok {
		updateType = "edited_message"
		msg = m
	} else if c, ok := update["callback_query"].(map[string]any); ok {
		updateType = "callback_query"
		cb = c
	} else {
		return nil
	}

	updateID, _ := getNumber(update["update_id"])

	var chatID *int64
	var userID *int64
	var text string
	var from map[string]any

	if msg != nil {
		if chat, ok := msg["chat"].(map[string]any); ok {
			if id, ok := getNumber(chat["id"]); ok {
				chatID = &id
			}
		}
		if f, ok := msg["from"].(map[string]any); ok {
			from = f
			if id, ok := getNumber(f["id"]); ok {
				userID = &id
			}
		}
		if s, ok := msg["text"].(string); ok {
			text = s
		}
	}
	if cb != nil {
		if m, ok := cb["message"].(map[string]any); ok {
			if chat, ok := m["chat"].(map[string]any); ok {
				if id, ok := getNumber(chat["id"]); ok {
					chatID = &id
				}
			}
		}
		if f, ok := cb["from"].(map[string]any); ok {
			from = f
			if id, ok := getNumber(f["id"]); ok {
				userID = &id
			}
		}
		if s, ok := cb["data"].(string); ok {
			text = s
		}
	}

	var senderName, senderUsername string
	if from != nil {
		first, _ := from["first_name"].(string)
		last, _ := from["last_name"].(string)
		uname, _ := from["username"].(string)
		senderUsername = uname

		combined := ""
		if first != "" {
			combined = first
		}
		if last != "" {
			if combined != "" {
				combined += " "
			}
			combined += last
		}
		if combined != "" {
			senderName = combined
		} else {
			senderName = uname
		}
	}

	return &parsedTelegramUpdate{
		UpdateType:     updateType,
		UpdateID:       updateID,
		ChatID:         chatID,
		UserID:         userID,
		Text:           text,
		SenderName:     senderName,
		SenderUsername: senderUsername,
	}
}

// telegramUpdateToPayload converts a parsed update + raw update into the
// normalized TriggerPayload. The Raw field is a map that includes tenant
// resolution helpers (chatId, userId, username, usernameOrId) alongside the
// original update fields.
func telegramUpdateToPayload(parsed *parsedTelegramUpdate, raw map[string]any) TriggerPayload {
	enriched := make(map[string]any, len(raw)+6)
	for k, v := range raw {
		enriched[k] = v
	}

	if parsed.ChatID != nil {
		enriched["chatId"] = *parsed.ChatID
	}
	if parsed.UserID != nil {
		enriched["userId"] = *parsed.UserID
	}
	if parsed.SenderUsername != "" {
		enriched["username"] = parsed.SenderUsername
	}
	enriched["usernameOrId"] = usernameOrId(parsed)
	enriched["updateType"] = parsed.UpdateType
	if parsed.Text != "" {
		enriched["text"] = parsed.Text
	}

	return TriggerPayload{
		Text:   parsed.Text,
		Source: "telegram",
		Raw:    enriched,
	}
}

func usernameOrId(p *parsedTelegramUpdate) string {
	if p.SenderUsername != "" {
		return p.SenderUsername
	}
	if p.UserID != nil {
		return strconv.FormatInt(*p.UserID, 10)
	}
	if p.ChatID != nil {
		return strconv.FormatInt(*p.ChatID, 10)
	}
	return ""
}

// --- Helpers ---

// getNumber extracts a numeric value as int64 from an any (supports float64,
// int, int64, json.Number).
func getNumber(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case float32:
		return int64(n), true
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i, true
		}
	}
	return 0, false
}

func containsString(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

// extractResponseText attempts to pull a response string out of a handler
// result. Accepts strings, or maps/objects with a "text" field.
func extractResponseText(result any) string {
	if result == nil {
		return ""
	}
	switch v := result.(type) {
	case string:
		return v
	case map[string]any:
		if s, ok := v["text"].(string); ok && s != "" {
			return s
		}
		// Fall back to JSON encoding of the whole object.
		if b, err := json.Marshal(v); err == nil {
			return string(b)
		}
	}
	// Last resort: JSON-encode anything else.
	if b, err := json.Marshal(result); err == nil {
		s := string(b)
		if s == "null" {
			return ""
		}
		return s
	}
	return ""
}
