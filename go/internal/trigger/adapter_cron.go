package trigger

import (
	"context"
	"fmt"
	"time"
)

// CronAdapter fires events on a fixed interval.
type CronAdapter struct {
	interval time.Duration
	payload  string // static text payload sent on each tick
	cancel   context.CancelFunc
}

// NewCronAdapter creates a new CronAdapter that fires every interval with the
// given static payload text.
func NewCronAdapter(interval time.Duration, payload string) *CronAdapter {
	return &CronAdapter{
		interval: interval,
		payload:  payload,
	}
}

// Start begins the cron ticker. It blocks until the context is cancelled.
func (c *CronAdapter) Start(ctx context.Context, handler EventHandler) error {
	if c.interval <= 0 {
		return fmt.Errorf("cron adapter: interval must be positive, got %v", c.interval)
	}

	ctx, c.cancel = context.WithCancel(ctx)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			payload := TriggerPayload{
				Text:   c.payload,
				Source: "cron",
				Raw:    map[string]any{"tick": time.Now().UTC().Format(time.RFC3339)},
			}
			if _, err := handler(ctx, payload); err != nil {
				// Log but don't stop; cron keeps ticking.
				continue
			}
		}
	}
}

// Stop cancels the cron ticker.
func (c *CronAdapter) Stop() error {
	if c.cancel != nil {
		c.cancel()
	}
	return nil
}
