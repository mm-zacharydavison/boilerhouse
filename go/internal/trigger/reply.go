package trigger

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// ReplyContext names the outbound channel provider that should receive a
// trigger's reply, plus that provider's own config block. Cron and one-shot
// adapters can fire without an inbound channel of their own — the firing
// handler reads this context off the trigger's spec.config.replyContext and
// uses it to fan the driver's response back to the named provider.
type ReplyContext struct {
	Adapter string          `json:"adapter"`
	Config  json.RawMessage `json:"config,omitempty"`
}

// ReplySender delivers reply text to one outbound channel.
type ReplySender interface {
	Send(ctx context.Context, text string) error
}

// replySenderFactories maps an adapter name to the factory that builds its
// ReplySender from the provider-specific config block. Adding a channel
// provider means adding one entry here plus a reply_<provider>.go file.
var replySenderFactories = map[string]func(config json.RawMessage) (ReplySender, error){
	"telegram": newTelegramReplySender,
}

// replyHTTPClient is package-private so tests can override timeouts. Defaults
// to a generous 30s — outbound channel providers occasionally take seconds to
// respond.
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
	factory, ok := replySenderFactories[rc.Adapter]
	if !ok {
		return fmt.Errorf("reply: unsupported adapter %q", rc.Adapter)
	}
	sender, err := factory(rc.Config)
	if err != nil {
		return err
	}
	return sender.Send(ctx, text)
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
