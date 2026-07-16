package trigger

import (
	"context"
	"sync"
	"time"
)

// OneShotAdapter fires its handler exactly once at runAt and then exits. After
// firing it invokes onFired (if set) so the gateway can mark the trigger as
// done — without that, a gateway restart would re-fire every past one-shot
// because runAt is now in the past.
type OneShotAdapter struct {
	runAt   time.Time
	payload string

	// onFired is called once after the handler returns successfully. The
	// gateway uses this hook to mark Status.Phase=Fired so the same one-shot
	// is not re-armed across operator restarts. May be nil for tests.
	onFired func(context.Context) error

	cancel context.CancelFunc
	once   sync.Once
}

// NewOneShotAdapter creates a one-shot adapter that fires once at runAt.
func NewOneShotAdapter(runAt time.Time, payload string, onFired func(context.Context) error) *OneShotAdapter {
	return &OneShotAdapter{
		runAt:   runAt,
		payload: payload,
		onFired: onFired,
	}
}

// Start blocks until runAt is reached (firing the handler once) or until ctx
// is cancelled. Past-due one-shots fire immediately. The adapter never
// re-fires on its own.
func (a *OneShotAdapter) Start(ctx context.Context, handler EventHandler) error {
	ctx, a.cancel = context.WithCancel(ctx)

	delay := time.Until(a.runAt)
	if delay < 0 {
		delay = 0
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return nil
	case <-timer.C:
	}

	payload := TriggerPayload{
		Text:   a.payload,
		Source: "one-shot",
		Raw:    map[string]any{"firedAt": time.Now().UTC().Format(time.RFC3339)},
	}
	if _, err := handler(ctx, payload); err != nil {
		return err
	}

	if a.onFired != nil {
		_ = a.onFired(ctx)
	}
	return nil
}

// Stop cancels the wait. Called by the gateway when the trigger is removed or
// transitions out of Active.
func (a *OneShotAdapter) Stop() error {
	a.once.Do(func() {
		if a.cancel != nil {
			a.cancel()
		}
	})
	return nil
}
