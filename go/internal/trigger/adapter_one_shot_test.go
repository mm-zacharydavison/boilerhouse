package trigger

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOneShotAdapter_FiresAtRunAt(t *testing.T) {
	runAt := time.Now().Add(50 * time.Millisecond)

	var calls int32
	var firedCalls int32
	handler := func(ctx context.Context, p TriggerPayload) (any, error) {
		atomic.AddInt32(&calls, 1)
		assert.Equal(t, "payload-text", p.Text)
		assert.Equal(t, "one-shot", p.Source)
		return nil, nil
	}
	onFired := func(ctx context.Context) error {
		atomic.AddInt32(&firedCalls, 1)
		return nil
	}

	adapter := NewOneShotAdapter(runAt, "payload-text", onFired)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	require.NoError(t, adapter.Start(ctx, handler))

	assert.Equal(t, int32(1), atomic.LoadInt32(&calls))
	assert.Equal(t, int32(1), atomic.LoadInt32(&firedCalls))
}

func TestOneShotAdapter_PastDueFiresImmediately(t *testing.T) {
	runAt := time.Now().Add(-1 * time.Hour)

	var calls int32
	handler := func(ctx context.Context, p TriggerPayload) (any, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	}

	adapter := NewOneShotAdapter(runAt, "", nil)

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	start := time.Now()
	require.NoError(t, adapter.Start(ctx, handler))
	elapsed := time.Since(start)

	assert.Equal(t, int32(1), atomic.LoadInt32(&calls))
	assert.Less(t, elapsed, 250*time.Millisecond, "past-due one-shot should fire immediately")
}

func TestOneShotAdapter_ContextCancellationBeforeFire(t *testing.T) {
	runAt := time.Now().Add(5 * time.Second)

	var calls int32
	handler := func(ctx context.Context, p TriggerPayload) (any, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	}

	adapter := NewOneShotAdapter(runAt, "x", nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- adapter.Start(ctx, handler)
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("Start did not return after cancel")
	}

	assert.Equal(t, int32(0), atomic.LoadInt32(&calls), "handler must not fire after cancel")
}

func TestOneShotAdapter_StopCancels(t *testing.T) {
	runAt := time.Now().Add(5 * time.Second)

	var calls int32
	handler := func(ctx context.Context, p TriggerPayload) (any, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	}

	adapter := NewOneShotAdapter(runAt, "x", nil)

	ctx := context.Background()
	done := make(chan error, 1)
	go func() {
		done <- adapter.Start(ctx, handler)
	}()

	time.Sleep(50 * time.Millisecond)
	require.NoError(t, adapter.Stop())

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("Start did not return after Stop")
	}

	assert.Equal(t, int32(0), atomic.LoadInt32(&calls))
}
