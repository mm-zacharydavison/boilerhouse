package trigger

import "context"

// TriggerPayload is the normalized event shape all adapters produce.
type TriggerPayload struct {
	Text   string `json:"text"`
	Source string `json:"source"` // "webhook", "slack", "telegram", "cron"
	Raw    any    `json:"raw"`
}

// Adapter receives external events and calls the handler for each.
type Adapter interface {
	Start(ctx context.Context, handler EventHandler) error
	Stop() error
}

// EventHandler is called by adapters when an event arrives.
type EventHandler func(ctx context.Context, payload TriggerPayload) (any, error)
