# Processing Progress Feedback Implementation Plan

**Goal:** Show real-time progress to users while a message is being processed. The core
system emits platform-agnostic status transitions; each trigger adapter translates those
into platform-native actions (Telegram typing + emoji, Slack reactions, future: WhatsApp
read receipts, Discord typing, web UI progress bar, etc.).

**Key design principle:** The pipeline only knows about `ProcessingStage` — a plain
status enum. It never calls platform-specific APIs. Each adapter registers a
`ProgressReporter` factory that knows how to render stages for its platform. New
platforms only need to implement one interface.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Pipeline (platform-agnostic)                               │
│                                                             │
│  adapter receives message                                   │
│    → reporter = adapter.createProgressReporter(eventCtx)    │
│    → reporter.update("received")                            │
│    → enqueue job (reporter stored in-memory by UUID)        │
│    → reporter.update("queued")                              │
│    → worker picks up job                                    │
│    → reporter.update("running")                             │
│    → dispatch completes                                     │
│    → reporter.update("done") or reporter.update("error")   │
│    → reporter.dispose()                                     │
└─────────────────────────────────────────────────────────────┘
          │
          │  ProgressReporter.update(stage)
          │  (each adapter implements differently)
          ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Telegram    │  │  Slack       │  │  Discord     │  │  Web UI      │
│              │  │              │  │  (future)    │  │  (future)    │
│ sendChatActn │  │ reactions.add│  │ typing start │  │ SSE progress │
│ setReaction  │  │ ephemeral   │  │ embed edit   │  │ bar update   │
│ typing loop  │  │ react swap  │  │              │  │              │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

---

## Stage Definitions

```typescript
export type ProcessingStage = "received" | "queued" | "running" | "done" | "error";
```

| Stage | Meaning | When emitted |
|-------|---------|-------------|
| `received` | Adapter got the message | Immediately in adapter, before queuing |
| `queued` | Job entered BullMQ | In `enqueue()` after push |
| `running` | Worker picked up the job | In worker, before `dispatcher.dispatch()` |
| `done` | Dispatch succeeded, reply sent | In worker `finally` block |
| `error` | Dispatch failed permanently | In worker `finally` block |

Stages are always emitted in order. Skipping is allowed (e.g. direct dispatch skips
`queued`). Going backward is not. Adapters may ignore stages they don't care about.

---

## Core Interface

**File:** `packages/triggers/src/progress.ts`

```typescript
export type ProcessingStage = "received" | "queued" | "running" | "done" | "error";

/**
 * Platform-agnostic progress reporter. Each adapter creates one per inbound
 * event. The pipeline calls update() at stage transitions — the reporter
 * translates that into platform-native actions.
 *
 * Contract:
 * - update() must never throw — swallow all errors internally.
 * - update() may be called multiple times with the same stage (idempotent).
 * - dispose() is always called exactly once, after the final update().
 * - Implementations must be safe to call from any async context.
 */
export interface ProgressReporter {
  /** Signal a stage transition. */
  update(stage: ProcessingStage): Promise<void>;
  /** Clean up any persistent resources (timers, connections). */
  dispose(): Promise<void>;
}

/** No-op reporter for adapters that don't support progress (webhook, cron). */
export class NullProgressReporter implements ProgressReporter {
  async update(_stage: ProcessingStage): Promise<void> {}
  async dispose(): Promise<void> {}
}
```

Note the interface is intentionally minimal — `update(stage)` and `dispose()`. No
`advance`/`finish` split, no `stage: "done" | "error"` overload. Each adapter's
`update()` implementation checks the stage value and acts accordingly. This keeps
the interface trivial to implement for new platforms.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `packages/triggers/src/progress.ts` | `ProgressReporter` interface, `ProcessingStage` type, `NullProgressReporter` |
| Create | `packages/triggers/src/adapters/telegram-progress.ts` | `TelegramProgressReporter` |
| Create | `packages/triggers/src/adapters/telegram-progress.test.ts` | Unit tests |
| Create | `packages/triggers/src/adapters/slack-progress.ts` | `SlackProgressReporter` |
| Create | `packages/triggers/src/adapters/slack-progress.test.ts` | Unit tests |
| Modify | `packages/triggers/src/dispatcher.ts` | Add `progressReporter?: ProgressReporter` to `TriggerEvent` |
| Modify | `packages/triggers/src/trigger-queue-manager.ts` | Store reporter in-memory by UUID; emit stages in worker |
| Modify | `packages/triggers/src/adapters/telegram-poll.ts` | Create reporter, attach to event |
| Modify | `packages/triggers/src/adapters/slack.ts` | Create reporter, attach to event |
| Modify | `packages/triggers/src/index.ts` | Export types |

**Queue serialization note:** `ProgressReporter` instances are not serializable into
Redis. Stored in an in-memory map in `TriggerQueueManager` keyed by UUID (same pattern
as `respondCallbacks`). Worker looks up by UUID. If worker restarts and map is gone,
`NullProgressReporter` is used — progress degrades gracefully.

---

## Task 1: Core interface + pipeline integration

### `packages/triggers/src/progress.ts`

As shown above — `ProcessingStage`, `ProgressReporter`, `NullProgressReporter`.

### `packages/triggers/src/dispatcher.ts`

Add to `TriggerEvent`:
```typescript
progressReporter?: ProgressReporter;
```

### `packages/triggers/src/trigger-queue-manager.ts`

Add `progressCallbackId: string | null` to `QueueJobData`.

Add `private progressCallbacks = new Map<string, ProgressReporter>()`.

In `enqueue()`:
```typescript
let progressCallbackId: string | null = null;
if (event.progressReporter) {
  progressCallbackId = randomUUID();
  this.progressCallbacks.set(progressCallbackId, event.progressReporter);
}
// After BullMQ push:
event.progressReporter?.update("queued").catch(() => {});
```

In worker processor:
```typescript
const reporter: ProgressReporter = (data.progressCallbackId
  ? this.progressCallbacks.get(data.progressCallbackId)
  : undefined) ?? new NullProgressReporter();

await reporter.update("running");

let succeeded = false;
try {
  // ... existing dispatch + sendReply logic ...
  succeeded = true;
} finally {
  await reporter.update(succeeded ? "done" : "error");
  await reporter.dispose();
  if (data.progressCallbackId) this.progressCallbacks.delete(data.progressCallbackId);
}
```

In `close()`: `this.progressCallbacks.clear()`.

### Tests (add to `trigger-queue-manager.test.ts`)

- `enqueue` stores UUID when reporter provided; null when absent.
- Worker calls `update("running")` before dispatch.
- Worker calls `update("done")` + `dispose()` after success.
- Worker calls `update("error")` + `dispose()` on failure.
- Worker uses `NullProgressReporter` when callback absent.
- `dispose()` is always called exactly once.

---

## Task 2: Telegram adapter helpers

**File:** `packages/triggers/src/adapters/telegram-parse.ts`

Add `messageId: number | undefined` to `ParsedTelegramUpdate`. Extract from
`message.message_id` in `parseTelegramUpdate`.

Add two exported helpers after `sendTelegramMessage`:

### `sendChatAction(botToken, chatId, action, apiBaseUrl?)`

POSTs to `/sendChatAction` with `{ chat_id, action }`. Swallows all errors.

### `setMessageReaction(botToken, chatId, messageId, emoji: string | null, apiBaseUrl?)`

POSTs to `/setMessageReaction`. Pass `null` to clear. Swallows all errors.

### Tests

- Correct URL and payload for each helper.
- `null` emoji sends empty `reaction: []`.

---

## Task 3: Slack adapter helpers

**File:** `packages/triggers/src/adapters/slack.ts`

Add three exported helpers:

### `addSlackReaction(botToken, channel, timestamp, name, apiBaseUrl?)`
### `removeSlackReaction(botToken, channel, timestamp, name, apiBaseUrl?)`
### `postSlackEphemeral(botToken, channel, userId, text, apiBaseUrl?)`

All swallow errors. Standard Slack Web API calls.

### Tests

- Each helper POSTs to correct endpoint with correct payload.

---

## Task 4: `TelegramProgressReporter`

**File:** `packages/triggers/src/adapters/telegram-progress.ts`

The Telegram adapter translates stages into typing indicators + emoji reactions.

```typescript
/** How Telegram renders each stage. */
const STAGE_EMOJI: Partial<Record<ProcessingStage, string>> = {
  received: "👀",
  queued:   "⏳",
  running:  "🧠",
  error:    "❌",
  // done: no emoji — reaction is cleared
};

const DEFAULT_KEEPALIVE_MS = 4_500;

export class TelegramProgressReporter implements ProgressReporter {
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  constructor(
    private botToken: string,
    private chatId: number,
    private messageId: number,
    private apiBaseUrl = "https://api.telegram.org",
    private options: { keepaliveIntervalMs?: number } = {},
  ) {}

  async update(stage: ProcessingStage): Promise<void> {
    if (this.finished) return;

    // Typing indicator for immediate feedback
    if (stage !== "done" && stage !== "error") {
      await sendChatAction(this.botToken, this.chatId, "typing", this.apiBaseUrl);
    }

    // Emoji reaction on the user's message
    const emoji = STAGE_EMOJI[stage];
    if (emoji) {
      await setMessageReaction(this.botToken, this.chatId, this.messageId, emoji, this.apiBaseUrl);
    } else if (stage === "done") {
      // Clear reaction on success
      await setMessageReaction(this.botToken, this.chatId, this.messageId, null, this.apiBaseUrl);
    }

    // Start keepalive loop when work begins (Telegram typing expires after ~5s)
    if (stage === "running" && !this.keepaliveTimer) {
      const intervalMs = this.options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
      this.keepaliveTimer = setInterval(() => {
        if (this.finished) return;
        sendChatAction(this.botToken, this.chatId, "typing", this.apiBaseUrl);
      }, intervalMs);
    }

    if (stage === "done" || stage === "error") {
      this.finished = true;
    }
  }

  async dispose(): Promise<void> {
    this.finished = true;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
```

### Tests (`telegram-progress.test.ts`)

- `update("received")` → sends typing action + 👀 reaction.
- `update("running")` → sends typing + 🧠 reaction + starts keepalive timer.
- `update("done")` → clears reaction, sets `finished = true`.
- `update("error")` → sets ❌ reaction, sets `finished = true`.
- Keepalive fires repeatedly (test at 50ms interval, wait 180ms → ≥2 calls).
- `dispose()` stops keepalive timer.
- Calls after `finished = true` are no-ops.

---

## Task 5: `SlackProgressReporter`

**File:** `packages/triggers/src/adapters/slack-progress.ts`

Slack translates stages into emoji reactions (swapping previous for current) and an
ephemeral "working on it" message.

```typescript
const STAGE_REACTION: Partial<Record<ProcessingStage, string>> = {
  received: "eyes",
  queued:   "hourglass_flowing_sand",
  running:  "brain",
  error:    "x",
  // done: no reaction — previous is removed
};

export class SlackProgressReporter implements ProgressReporter {
  private currentReaction: string | null = null;

  constructor(
    private botToken: string,
    private channel: string,
    private messageTimestamp: string,
    private userId: string,
    private apiBaseUrl = "https://slack.com/api",
  ) {}

  async update(stage: ProcessingStage): Promise<void> {
    const nextReaction = STAGE_REACTION[stage];

    // Remove previous reaction
    if (this.currentReaction) {
      await removeSlackReaction(this.botToken, this.channel, this.messageTimestamp, this.currentReaction, this.apiBaseUrl);
      this.currentReaction = null;
    }

    // Add new reaction (if any — done has none)
    if (nextReaction) {
      await addSlackReaction(this.botToken, this.channel, this.messageTimestamp, nextReaction, this.apiBaseUrl);
      this.currentReaction = nextReaction;
    }

    // Ephemeral status message when work starts
    if (stage === "running") {
      await postSlackEphemeral(this.botToken, this.channel, this.userId, "Working on it...", this.apiBaseUrl);
    }
  }

  async dispose(): Promise<void> {
    // Clean up any lingering reaction
    if (this.currentReaction) {
      await removeSlackReaction(this.botToken, this.channel, this.messageTimestamp, this.currentReaction, this.apiBaseUrl);
      this.currentReaction = null;
    }
  }
}
```

### Tests (`slack-progress.test.ts`)

- `update("received")` → adds `eyes` reaction.
- `update("running")` → removes `eyes`, adds `brain`, posts ephemeral.
- `update("done")` → removes `brain`, no new reaction.
- `update("error")` → removes previous, adds `x`.
- `dispose()` → removes any lingering reaction.

---

## Task 6: Wire reporters into adapters

### `packages/triggers/src/adapters/telegram-poll.ts`

After `parseTelegramUpdate`, before dispatch:

```typescript
const progressReporter = (parsed.chatId != null && parsed.messageId != null)
  ? new TelegramProgressReporter(botToken, parsed.chatId, parsed.messageId, apiBaseUrl)
  : undefined;

await progressReporter?.update("received");
```

Pass `progressReporter` on the `TriggerEvent`.

### `packages/triggers/src/adapters/slack.ts`

Extract `event.ts` as `messageTs`. After tenant resolution:

```typescript
const progressReporter = (channel && messageTs && user)
  ? new SlackProgressReporter(trigger.config.botToken, channel, messageTs, user)
  : undefined;

await progressReporter?.update("received");
```

Pass `progressReporter` on the `TriggerEvent`.

---

## Task 7: Exports

**File:** `packages/triggers/src/index.ts`

```typescript
export type { ProgressReporter, ProcessingStage } from "./progress";
export { NullProgressReporter } from "./progress";
export { TelegramProgressReporter } from "./adapters/telegram-progress";
export { SlackProgressReporter } from "./adapters/slack-progress";
export { sendChatAction, setMessageReaction } from "./adapters/telegram-parse";
export { addSlackReaction, removeSlackReaction, postSlackEphemeral } from "./adapters/slack";
```

---

## Adding a New Platform

When a new trigger adapter is added (e.g. Discord, WhatsApp, web UI), implementing
progress feedback requires exactly one thing: a class that implements `ProgressReporter`.

### Example: Discord (hypothetical)

```typescript
export class DiscordProgressReporter implements ProgressReporter {
  constructor(
    private botToken: string,
    private channelId: string,
    private statusMessageId: string, // bot's own "processing..." message
  ) {}

  async update(stage: ProcessingStage): Promise<void> {
    switch (stage) {
      case "received":
        await discordTriggerTyping(this.botToken, this.channelId);
        break;
      case "running":
        await discordEditMessage(this.botToken, this.channelId, this.statusMessageId,
          "Processing your request...");
        break;
      case "done":
        await discordDeleteMessage(this.botToken, this.channelId, this.statusMessageId);
        break;
      case "error":
        await discordEditMessage(this.botToken, this.channelId, this.statusMessageId,
          "Something went wrong.");
        break;
    }
  }

  async dispose(): Promise<void> {
    // Clean up status message if still present
  }
}
```

### Example: Web UI (hypothetical)

```typescript
export class WebUIProgressReporter implements ProgressReporter {
  constructor(private ws: WebSocket) {}

  async update(stage: ProcessingStage): Promise<void> {
    // Send stage over the WebSocket — the client renders a progress bar
    this.ws.send(JSON.stringify({ type: "progress", stage }));
  }

  async dispose(): Promise<void> {}
}
```

### What the new adapter does NOT need to know

- How `TriggerQueueManager` stores the callback
- When stages are emitted
- What other adapters do for the same stage
- The existence of BullMQ, Redis, or the dispatcher

The pipeline emits `update(stage)` — the adapter decides what that means for its
platform. That's the entire contract.

---

## Streaming progress for long-running drivers

Claude Code can take minutes to respond. Platform-specific handling:

- **Telegram:** 4500ms keepalive loop re-sends `sendChatAction(typing)` to prevent
  the indicator from expiring.
- **Slack:** The `brain` emoji reaction persists for the duration — no keepalive needed.
- **Discord (future):** Discord typing indicator lasts 10s — would need a similar
  keepalive at ~9s intervals.
- **Web UI (future):** The WebSocket connection stays open; client shows a spinner.
  Optionally, the driver can emit sub-stages (e.g. "searching", "writing") if the
  protocol supports it — but that's a driver-level concern, not a pipeline concern.

Each adapter handles its platform's quirks in its own `update()` / `dispose()` methods.
The pipeline doesn't know or care about typing indicator TTLs.

---

## Test Strategy

Each task follows TDD: write failing test → implement → confirm passing. All tests mock
`fetch` (via `global.fetch = mock(...)` or `Bun.serve` local server). No real network
calls in `bun test`.

Key invariants to test across all reporters:
- `update()` never throws (swallows all errors).
- `dispose()` is safe to call multiple times.
- `dispose()` cleans up all timers / persistent indicators.
- Stages after `done`/`error` are no-ops.

Run all: `bun test packages/triggers/`

---

## Open Questions

- **Sub-stages within `running`:** Some drivers could provide more granular progress
  (e.g. Claude Code streaming tool use names). This could be modeled as
  `update("running", { detail: "searching codebase" })` — but keep it out of scope
  for v1. The interface accepts only `ProcessingStage` for now. If sub-stages are
  needed later, extend `update()` with an optional second argument rather than
  changing the type.
- **Per-adapter stage mapping config:** Should the emoji/reaction mapping be
  configurable (e.g. per-trigger config)? Probably not for v1 — hardcode sensible
  defaults per platform. Reconsider if operators request it.
- **WhatsApp specifics:** WhatsApp Business API supports read receipts and typing
  indicators but has strict rate limits. The reporter should throttle calls. This
  is a WhatsApp adapter concern, not a pipeline concern.
