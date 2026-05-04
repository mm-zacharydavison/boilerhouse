# Processing Progress Feedback (Go)

## Status

### Already Implemented
- **Telegram adapter poll loop and parsing** (`go/internal/trigger/adapter_telegram.go:186-257`): full lifecycle for receiving and dispatching messages.
- **`parseTelegramUpdate()`** (`adapter_telegram.go:415`): extracts chat ID, user ID, text, sender name — ready for MessageID extension.
- **`getNumber()` helper** (`adapter_telegram.go:563`): parses numeric fields from JSON; will be used to extract `message_id`.
- **Claim activation** (`go/internal/operator/claim_activate.go:48`): sets `Phase=Active`; gateway polls for this at `gateway.go:350`.
- **Gateway handler pipeline** (`go/internal/trigger/gateway.go:205-237`): `buildHandler()` orchestrates guards → `ensureClaim` → `driver.Send`.

### Outstanding
1. Create `go/internal/trigger/progress.go` — `ProcessingStage` const type, `ProgressReporter` interface, `NoopProgressReporter`.
2. Add `Progress ProgressReporter` field (with `json:"-"`) to `TriggerPayload` in `go/internal/trigger/adapter.go`.
3. In `gateway.buildHandler()` (`gateway.go:205`): call `payload.Progress.Update(ctx, StageRunning)` after `ensureClaim` returns, before `driver.Send`.
4. Create `go/internal/trigger/telegram_progress.go` — `TelegramProgressReporter` with typing keepalive (4.5s interval), emoji reactions (👀 received, 🧠 running, ❌ error, clear on done), goroutine-safe `finished` flag.
5. Modify `adapter_telegram.go`: extract `MessageID` from `msg["message_id"]` using `getNumber()`; create reporter per-update; emit `StageReceived` before handler, `StageDone`/`StageError` after.
6. Create `go/internal/trigger/telegram_progress_test.go` — mock HTTP server, assert reactions/typing per stage, keepalive ticker, safe double-Dispose, no-ops after finished.
7. Add gateway integration test in `gateway_test.go` verifying `StageRunning` is emitted between guards and dispatch.

---

**Goal:** Show real-time progress to users while a message is being processed. The trigger gateway emits platform-agnostic stage transitions; each adapter translates them into platform-native actions (Telegram typing + emoji; future: Slack reactions, Discord typing, web UI progress).

**Key design principle:** the gateway only knows about `ProcessingStage`. It never calls platform-specific APIs. Each adapter implements one `ProgressReporter` interface to opt in.

---

## What changed from the TS plan

The TS plan had a five-stage lifecycle (`received → queued → running → done|error`) because BullMQ added a queue between the adapter and the worker. **The Go gateway is synchronous** (`gateway.go:198` `driver.Send` blocks until the workload responds). There's no queue, so:

- `queued` stage **collapses** — there is nothing to enqueue.
- The in-memory `progressCallbacks` UUID map disappears — the adapter holds the reporter directly on the goroutine stack.
- Stages reduce to: **`received`, `running`, `done`, `error`**.

The interface itself is identical to the TS plan; only the lifecycle is shorter.

Slack reporter is **deferred** — no Slack adapter in Go yet.

---

## Architecture

```
TelegramAdapter.pollLoop receives an update
  ↓
parsed.ChatID != nil → reporter := NewTelegramProgressReporter(...)
  ↓
reporter.Update("received")               // 👀 reaction + typing
  ↓
result, err := t.handler(ctx, payload)    // synchronous: ensureClaim + driver.Send
  ↓ (just before t.handler runs in real time, the handler will internally:)
                                          // ensureClaim may take >1s if pool is empty
                                          // first time the loop sees an active claim, reporter.Update("running")
  ↓
err == nil ? reporter.Update("done") : reporter.Update("error")
reporter.Dispose()
```

The `running` stage is interesting. It should fire **after the claim is Active and dispatch is about to send**, not "as soon as the handler is called" — otherwise the user sees the 🧠 emoji while we're still waiting on a cold pool. Two options:

- **(A) Fire `running` from inside `gateway.buildHandler`** after `ensureClaim` returns, before `driver.Send`. Requires plumbing a reporter through `EventHandler`.
- **(B) Fire `running` from the adapter, but with a bounded delay** — e.g. 500ms after `received`. Simpler but less precise.

Recommend **(A)**: extend `EventHandler` to optionally receive a `ProgressReporter`. Adapters that don't supply one get `NoopProgressReporter`. The handler calls `reporter.Update("running")` between `ensureClaim` and `driver.Send`.

---

## Stage Definitions

```go
package trigger

type ProcessingStage string

const (
    StageReceived ProcessingStage = "received"  // adapter got the event
    StageRunning  ProcessingStage = "running"   // claim active, about to dispatch
    StageDone     ProcessingStage = "done"      // dispatch succeeded
    StageError    ProcessingStage = "error"     // dispatch failed
)
```

Stages are always emitted in order. Adapters may ignore stages they don't care about. `Update` must never return an error — implementations swallow errors internally.

---

## Core Interface

`go/internal/trigger/progress.go`:

```go
package trigger

import "context"

// ProgressReporter is the platform-agnostic progress callback. Adapters
// implement it to translate stage transitions into native UI actions.
//
// Contract:
//   - Update never returns an error. Implementations swallow errors.
//   - Update may be called multiple times with the same stage (idempotent).
//   - Dispose is called exactly once after the final Update.
//   - Implementations must be goroutine-safe.
type ProgressReporter interface {
    Update(ctx context.Context, stage ProcessingStage)
    Dispose()
}

// NoopProgressReporter is the default when an adapter doesn't supply one.
type NoopProgressReporter struct{}

func (NoopProgressReporter) Update(context.Context, ProcessingStage) {}
func (NoopProgressReporter) Dispose()                                 {}
```

---

## Wiring Through `EventHandler`

Current signature (`adapter.go`):

```go
type EventHandler func(ctx context.Context, payload TriggerPayload) (any, error)
```

Two ways to thread the reporter:

1. **Add to `TriggerPayload`** (cheap, compatible).
2. **Add a separate parameter** (cleaner, breaks signature).

Recommend **option 1**:

```go
type TriggerPayload struct {
    // ... existing fields ...
    Progress ProgressReporter `json:"-"`  // not serialized; in-process only
}
```

This requires no signature change. The handler in `gateway.buildHandler` (line 177) reads `payload.Progress` (defaulting to noop):

```go
return func(ctx context.Context, payload TriggerPayload) (any, error) {
    rep := payload.Progress
    if rep == nil { rep = NoopProgressReporter{} }

    tenantId, err := ResolveTenantId(trigger.Spec.Tenant, payload)
    if err != nil { return nil, err }

    for _, guard := range guards {
        if err := guard.Check(ctx, tenantId, payload); err != nil {
            return nil, fmt.Errorf("guard check failed: %w", err)
        }
    }

    endpoint, err := g.ensureClaim(ctx, tenantId, trigger.Spec.WorkloadRef)
    if err != nil { return nil, err }

    rep.Update(ctx, StageRunning)   // <-- new

    return driver.Send(ctx, endpoint, payload)
}
```

Adapters set `payload.Progress` before calling the handler. The handler is responsible only for `running`. Adapters own `received`, `done`, `error`, and `Dispose`.

---

## Telegram Reporter

`go/internal/trigger/telegram_progress.go`:

```go
package trigger

import (
    "context"
    "net/http"
    "sync"
    "time"
)

const (
    telegramKeepaliveInterval = 4500 * time.Millisecond
)

var stageEmoji = map[ProcessingStage]string{
    StageReceived: "👀",
    StageRunning:  "🧠",
    StageError:    "❌",
    // StageDone: empty — clear reaction
}

type TelegramProgressReporter struct {
    httpClient *http.Client
    apiBaseURL string
    botToken   string
    chatID     int64
    messageID  int64

    mu              sync.Mutex
    finished        bool
    keepaliveCancel context.CancelFunc
}

func NewTelegramProgressReporter(httpClient *http.Client, apiBaseURL, botToken string, chatID, messageID int64) *TelegramProgressReporter {
    return &TelegramProgressReporter{
        httpClient: httpClient, apiBaseURL: apiBaseURL, botToken: botToken,
        chatID: chatID, messageID: messageID,
    }
}

func (r *TelegramProgressReporter) Update(ctx context.Context, stage ProcessingStage) {
    r.mu.Lock()
    if r.finished { r.mu.Unlock(); return }
    r.mu.Unlock()

    // Typing for ongoing stages.
    if stage != StageDone && stage != StageError {
        _ = r.sendChatAction(ctx, "typing")
    }

    // Reaction.
    if emoji, ok := stageEmoji[stage]; ok {
        _ = r.setReaction(ctx, emoji)
    } else if stage == StageDone {
        _ = r.setReaction(ctx, "")  // clear
    }

    // Start keepalive when work begins.
    if stage == StageRunning {
        r.startKeepalive(ctx)
    }

    if stage == StageDone || stage == StageError {
        r.mu.Lock()
        r.finished = true
        r.mu.Unlock()
        r.stopKeepalive()
    }
}

func (r *TelegramProgressReporter) Dispose() {
    r.mu.Lock()
    r.finished = true
    r.mu.Unlock()
    r.stopKeepalive()
}

// startKeepalive launches a goroutine that re-sends typing every 4.5s
// (Telegram's typing indicator expires after ~5s).
func (r *TelegramProgressReporter) startKeepalive(parent context.Context) {
    ctx, cancel := context.WithCancel(parent)
    r.mu.Lock()
    r.keepaliveCancel = cancel
    r.mu.Unlock()

    go func() {
        ticker := time.NewTicker(telegramKeepaliveInterval)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                r.mu.Lock()
                done := r.finished
                r.mu.Unlock()
                if done { return }
                _ = r.sendChatAction(ctx, "typing")
            }
        }
    }()
}

func (r *TelegramProgressReporter) stopKeepalive() {
    r.mu.Lock()
    cancel := r.keepaliveCancel
    r.keepaliveCancel = nil
    r.mu.Unlock()
    if cancel != nil { cancel() }
}

// sendChatAction POSTs /sendChatAction. Errors swallowed.
func (r *TelegramProgressReporter) sendChatAction(ctx context.Context, action string) error { ... }

// setReaction POSTs /setMessageReaction. emoji=="" clears the reaction.
func (r *TelegramProgressReporter) setReaction(ctx context.Context, emoji string) error { ... }
```

---

## Telegram Adapter Wiring

`adapter_telegram.go` `pollLoop` (line 198 area):

```go
// Add MessageID to parsedTelegramUpdate (extract from msg["message_id"]).
// Then in the loop:
var rep ProgressReporter = NoopProgressReporter{}
if parsed.ChatID != nil && parsed.MessageID != 0 {
    tgr := NewTelegramProgressReporter(t.httpClient, cfg.APIBaseURL, cfg.BotToken, *parsed.ChatID, parsed.MessageID)
    rep = tgr
    defer tgr.Dispose()
    rep.Update(ctx, StageReceived)
}

payload := t.telegramUpdateToPayload(ctx, cfg, parsed, update)
payload.Progress = rep

result, err := t.handler(ctx, payload)
if err != nil {
    rep.Update(ctx, StageError)
    t.log.Error("telegram handler error", "error", err)
    continue
}
rep.Update(ctx, StageDone)

// existing reply path follows...
```

`Dispose` runs at the end of the loop body (the existing `for _, update := range updates` iteration). Add a small helper to scope the deferred dispose per-iteration cleanly.

`MessageID` parsing: extract from `msg["message_id"]` in `parseTelegramUpdate` using the existing `getNumber` helper.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `go/internal/trigger/progress.go` | Create | `ProcessingStage`, `ProgressReporter`, `NoopProgressReporter` |
| `go/internal/trigger/adapter.go` | Modify | Add `Progress ProgressReporter` to `TriggerPayload` |
| `go/internal/trigger/telegram_progress.go` | Create | `TelegramProgressReporter` |
| `go/internal/trigger/telegram_progress_test.go` | Create | Unit tests with mocked telegram |
| `go/internal/trigger/adapter_telegram.go` | Modify | Extract `MessageID`, create+dispose reporter, set on payload |
| `go/internal/trigger/gateway.go` | Modify | Call `payload.Progress.Update(ctx, StageRunning)` between ensureClaim and driver.Send |

---

## Sequencing

1. `progress.go` types.
2. `TriggerPayload.Progress` field.
3. Gateway handler emits `StageRunning`.
4. `TelegramProgressReporter` + tests.
5. Telegram adapter wiring + `MessageID` extraction.

Items 1-2 in parallel. Items 3-4 in parallel. Item 5 depends on 4.

---

## Adding a New Platform

Implement one interface. Example shape for a future Slack reporter:

```go
type SlackProgressReporter struct {
    /* botToken, channel, messageTs, userId, currentReaction */
}
func (r *SlackProgressReporter) Update(ctx context.Context, stage ProcessingStage) {
    // remove previous reaction, add new one, post ephemeral on running
}
func (r *SlackProgressReporter) Dispose() { /* clear lingering reaction */ }
```

The new adapter never needs to know about the gateway, telegram, or any other platform.

---

## Test Strategy

All HTTP via `httptest.NewServer`. Tests assert:

- `Update(StageReceived)` → POSTs `sendChatAction` + `setMessageReaction` with 👀.
- `Update(StageRunning)` → typing + 🧠 + keepalive goroutine starts (use a 50ms test interval, sleep 180ms, assert ≥2 typing calls).
- `Update(StageDone)` → clears reaction, sets `finished=true`, keepalive stops.
- `Update(StageError)` → ❌ reaction, finished.
- `Dispose` is safe to call twice.
- After `finished=true`, further `Update` calls are no-ops.

Gateway-level test:

- Custom in-test handler that records progress callbacks. Trigger payload runs through `buildHandler` → handler sees `StageRunning` between guards and dispatch.

---

## Open Questions

- **Sub-stages within `running`:** Claude Code can stream tool-use names. If/when the driver supports stream events, extend `Update(stage, detail string)`. Out of scope for v1.
- **Per-adapter mapping config:** hardcoded emojis for now. Reconsider if operators ask.
- **`Update` blocking:** in the keepalive goroutine, `sendChatAction` blocks on HTTP. Use a short timeout via `ctx` or a bounded HTTP client timeout to avoid pinning the goroutine on slow Telegram responses.
- **Graceful cancel:** if the handler context is cancelled mid-`running`, the reporter still gets a `done`/`error` from the adapter — no orphan keepalives.
