# Feature Plan: Voice Memo Ingestion

Speech-to-text pipeline for voice messages from any chat platform (Telegram, Slack,
WhatsApp, Discord, etc.). Each adapter downloads the audio and passes it to a shared,
platform-agnostic transcription service backed by self-hosted Whisper.

**Key design principle:** The STT service is a standalone internal HTTP endpoint. Adapters
download platform-specific audio files and POST raw bytes to the STT service. The STT
service knows nothing about Telegram, Slack, or any messenger — it receives audio, returns
text. New platforms only need to extract audio bytes from their event format.

---

## Architecture

```
┌──────────────┐  ┌──────────────┐  ┌────���─────────┐  ┌──────────────┐
│  Telegram    │  │  Slack       │  │  WhatsApp    │  │  Discord     │
│  adapter     │  │  adapter     │  │  (future)    │  │  (future)    │
│              │  │              │  │              │  │              │
│ voice.file_id│  │ files[]      │  │ media URL    │  │ attachment   │
│ → getFile    │  │ → url_private│  │ → download   │  │ → CDN URL    │
│ → download   │  │ → download   │  │              │  │ → download   │
└──────┬───────┘  └──────┬───────┘  └──────���───────┘  └──────┬───────┘
       │                 │                 │                 │
       └────────────┬────┴────────────┬────┘                 │
                    ▼                 ▼                       ▼
            ┌──────────────────────────────────────────────────┐
            │  AudioAttachment { data: base64, mimeType }      │
            │  (on TriggerPayload, same pattern as images)     │
            └──────────────────────┬───────────────────────────┘
                                   │
                                   ▼
            ┌───��──────────────────────────────────────────────┐
            │  STT Service (self-hosted Whisper)                │
            │  POST /transcribe  { audio blob }  → { text }    │
            │  Runs as sidecar container or internal service    │
            └──���────────────────────────────────��──────────────┘
                                   │
                                   ▼
            ┌────────��─────────────────────────────���───────────┐
            │  TriggerPayload.text = transcript                │
            │  (downstream pipeline unchanged)                 │
            └───────────────────────────────────────��──────────┘
```

---

## Self-Hosted Whisper

### Deployment

Run Whisper as a sidecar container alongside the Boilerhouse API. Use an existing
OpenAI-compatible Whisper server image:

- **[`fedirz/faster-whisper-server`](https://github.com/fedirz/faster-whisper-server)** —
  GPU-accelerated, exposes `/v1/audio/transcriptions` (OpenAI-compatible API), supports
  `faster-whisper` backend. Recommended for production.
- **[`onerahmet/openai-whisper-asr-webservice`](https://github.com/ahmetoner/whisper-asr-webservice)** —
  CPU-friendly, same OpenAI-compatible endpoint. Good for dev/testing.

Both expose the same API shape as OpenAI's hosted Whisper:

```
POST /v1/audio/transcriptions
Content-Type: multipart/form-data
  file: <audio bytes>
  model: "whisper-1"    (or specific model name)
  language: "en"        (optional)

Response: { "text": "transcribed content" }
```

### Docker Compose addition

```yaml
services:
  whisper:
    image: fedirz/faster-whisper-server:latest
    environment:
      - WHISPER__MODEL=Systran/faster-whisper-base.en
    ports:
      - "8787:8000"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    # CPU fallback: remove the deploy.resources block and use
    # WHISPER__MODEL=Systran/faster-whisper-tiny.en for lighter weight
```

### Configuration

| Env var | Purpose | Default |
|---------|---------|---------|
| `WHISPER_URL` | Base URL of the Whisper service | `http://whisper:8000` |
| `WHISPER_MODEL` | Model name to send in requests | `whisper-1` |
| `WHISPER_LANGUAGE` | Language hint (ISO 639-1) | (auto-detect) |

The Boilerhouse API connects to Whisper over the Docker network — no public exposure
needed, no API keys, data stays local.

---

## Payload Extension

### `packages/triggers/src/config.ts`

Extend `TriggerPayload` with an optional `audio` field (same pattern as `images`):

```typescript
export interface AudioAttachment {
  /** MIME type, e.g. "audio/ogg", "audio/webm", "audio/mp4". */
  mimeType: string;
  /** Base64-encoded audio bytes. */
  data: string;
  /** Duration in seconds (if known from the platform). */
  duration?: number;
  /** Source reference for logging/debugging. */
  sourceRef: string;
}

export interface TriggerPayload {
  text: string;
  source: "telegram" | "slack" | "webhook" | "cron";
  raw: unknown;
  images?: ImageAttachment[];
  /** Attached audio (voice memos). Transcribed before dispatch. */
  audio?: AudioAttachment[];
}
```

Base64 for the same reason as images: JSON-serialisable across the BullMQ queue and
WebSocket driver protocol.

---

## Shared STT Client

### New file: `packages/triggers/src/stt.ts`

A platform-agnostic STT client that talks to the self-hosted Whisper service.

```typescript
export interface SttConfig {
  /** Whisper service URL. @default process.env.WHISPER_URL ?? "http://whisper:8000" */
  url?: string;
  /** Model to request. @default "whisper-1" */
  model?: string;
  /** Language hint (ISO 639-1). @default auto-detect */
  language?: string;
  /** Request timeout in ms. @default 60_000 */
  timeoutMs?: number;
}

/**
 * Transcribe audio via the self-hosted Whisper service.
 * Uses the OpenAI-compatible /v1/audio/transcriptions endpoint.
 */
export async function transcribeAudio(
  audioData: string,   // base64
  mimeType: string,
  config?: SttConfig,
): Promise<string> {
  const url = config?.url ?? process.env.WHISPER_URL ?? "http://whisper:8000";
  const model = config?.model ?? process.env.WHISPER_MODEL ?? "whisper-1";

  const audioBytes = Buffer.from(audioData, "base64");

  // Derive filename extension from MIME type for Whisper's format detection
  const ext = mimeExtension(mimeType);

  const form = new FormData();
  form.set("file", new Blob([audioBytes], { type: mimeType }), `audio.${ext}`);
  form.set("model", model);
  if (config?.language ?? process.env.WHISPER_LANGUAGE) {
    form.set("language", (config?.language ?? process.env.WHISPER_LANGUAGE)!);
  }

  const response = await fetch(`${url}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(config?.timeoutMs ?? 60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Whisper transcription failed (${response.status}): ${body}`);
  }

  const result = await response.json() as { text: string };
  return result.text;
}

function mimeExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/oga": "ogg",
    "audio/opus": "opus",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
  };
  return map[mimeType] ?? "ogg";
}
```

This function is entirely platform-agnostic. It doesn't know where the audio came from —
just base64 bytes and a MIME type.

---

## Transcription Step: Where It Happens

Transcription happens in each adapter, after downloading the audio and before constructing
the `TriggerPayload`. The adapter:

1. Detects voice/audio in the platform event.
2. Downloads the audio bytes (platform-specific).
3. Calls `transcribeAudio(base64, mimeType, sttConfig)` (shared).
4. Sets `payload.text` to the transcript (or prepends it to any caption).

This keeps `TriggerPayload` clean — downstream code (dispatcher, drivers, guards) sees
`text` and doesn't know or care that it came from audio.

---

## Per-Adapter Changes

### Telegram (`telegram-parse.ts` + `telegram-poll.ts`)

**`ParsedTelegramUpdate`** — add:
```typescript
voiceFileId: string | undefined;
voiceDuration: number | undefined;
```

**`parseTelegramUpdate`** — expand message type to include `voice?: { file_id: string; duration?: number }`.
Extract `voiceFileId = message?.voice?.file_id`, `voiceDuration = message?.voice?.duration`.

**New helper in `telegram-parse.ts`:**
```typescript
export async function downloadTelegramVoice(
  botToken: string,
  fileId: string,
  apiBaseUrl?: string,
): Promise<{ data: string; mimeType: string }>
```
Calls `getFile` → download → base64 encode. Returns `{ data, mimeType: "audio/ogg" }`.

**`telegram-poll.ts`** — in the poll loop, after parse and before payload construction:
```typescript
if (parsed.voiceFileId) {
  const { data, mimeType } = await downloadTelegramVoice(botToken, parsed.voiceFileId, apiBaseUrl);
  const transcript = await transcribeAudio(data, mimeType, sttConfig);
  parsed.text = transcript;
}
```

### Slack (`slack.ts`)

Slack voice clips arrive as `files[]` entries with `subtype: "slack_audio"` or
`mimetype: "audio/webm"`. The download flow is identical to image downloads:

```typescript
const audioFiles = (files ?? []).filter(f =>
  f.mimetype?.startsWith("audio/")
);

for (const f of audioFiles) {
  const url = f.url_private_download ?? f.url_private;
  const buffer = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  }).then(r => r.arrayBuffer());
  const data = Buffer.from(buffer).toString("base64");
  const transcript = await transcribeAudio(data, f.mimetype!, sttConfig);
  // Prepend transcript to text
  text = transcript + (text ? `\n\n${text}` : "");
}
```

### Future adapters (WhatsApp, Discord, etc.)

Each adapter just needs to:
1. Extract the audio URL/bytes from their platform's event format.
2. Download and base64-encode.
3. Call `transcribeAudio(data, mimeType, config)`.
4. Set `payload.text`.

No new interfaces to implement, no adapters to register. The shared `transcribeAudio`
function is the entire contract.

---

## STT Configuration

STT config lives at the global level (env vars), not per-trigger. All triggers share the
same Whisper service.

| Env var | Purpose | Default |
|---------|---------|---------|
| `WHISPER_URL` | Whisper service base URL | `http://whisper:8000` |
| `WHISPER_MODEL` | Model name for requests | `whisper-1` |
| `WHISPER_LANGUAGE` | Language hint (ISO 639-1) | auto-detect |

Adapters that want to override can pass an `SttConfig` object — but the default reads
from env vars, which is sufficient for most deployments.

---

## Data Flow (platform-agnostic)

```
Any adapter receives a voice message
  → adapter-specific download (Telegram getFile, Slack url_private, etc.)
  → AudioAttachment { data: base64, mimeType }
  → transcribeAudio(data, mimeType) → POST to self-hosted Whisper
  → transcript string
  → TriggerPayload { text: transcript, source, raw }
  → dispatcher.dispatch(...)
```

Downstream is unchanged. Guards, drivers, workloads see `TriggerPayload.text`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/triggers/src/config.ts` | Modify | Add `AudioAttachment` type, add `audio?` to `TriggerPayload` |
| `packages/triggers/src/stt.ts` | Create | Shared `transcribeAudio()` client for self-hosted Whisper |
| `packages/triggers/src/stt.test.ts` | Create | Unit tests for STT client |
| `packages/triggers/src/adapters/telegram-parse.ts` | Modify | Add `voiceFileId` to parsed update, add `downloadTelegramVoice` |
| `packages/triggers/src/adapters/telegram-poll.ts` | Modify | Wire transcription into poll loop |
| `packages/triggers/src/adapters/slack.ts` | Modify | Detect audio files, download + transcribe |
| `packages/triggers/src/index.ts` | Modify | Export `AudioAttachment`, `transcribeAudio`, `SttConfig` |
| `docker-compose.yml` | Modify | Add `whisper` service |

---

## Sequencing

1. `config.ts` — add `AudioAttachment` type. No behaviour change.
2. `stt.ts` + `stt.test.ts` — shared transcription client. Testable in isolation.
3. `docker-compose.yml` — add Whisper sidecar service.
4. `telegram-parse.ts` — add `voiceFileId` parsing + `downloadTelegramVoice`.
5. `telegram-poll.ts` — wire transcription into the poll loop.
6. `slack.ts` — detect and transcribe audio files.
7. `index.ts` — export new types.

Items 2-3 can be done in parallel. Items 4-6 can be done in parallel (all depend on 2).

---

## Error Handling

| Failure | Policy |
|---------|--------|
| Audio download fails (platform API error) | Log warning, skip update, advance offset |
| Whisper service unreachable | Log warning, skip update. Don't dispatch with empty text |
| Whisper returns error (bad audio, unsupported format) | Log warning, skip update |
| Whisper times out (>60s) | Log warning, skip update |

All failures are non-fatal to the adapter — one bad voice memo doesn't break the poll
loop. Add metric counter `stt.transcription.error` for observability.

Future option: `stt.onError: "skip" | "dispatch-empty"` config to let operators choose
whether to skip or dispatch with a `[Voice message could not be transcribed]` placeholder.

---

## Test Strategy

### `packages/triggers/src/stt.test.ts`

- Mock `fetch` to return `{ text: "hello world" }`. Assert correct URL, multipart form
  fields (`file`, `model`), and response parsing.
- Mock fetch to return 500. Assert error is thrown with status in message.
- Mock fetch to timeout. Assert error is thrown.
- Assert `mimeExtension` maps common audio MIME types correctly.

### `packages/triggers/src/adapters/telegram-parse.ts` tests

- `parseTelegramUpdate` with a `voice` message: assert `voiceFileId` extracted, `text`
  is `undefined`.
- `downloadTelegramVoice`: mock two fetch calls (`getFile` + file download). Assert
  base64 output and correct URLs.

### Integration test

- Mock Whisper server via `Bun.serve`. Send a Telegram voice update through the poll
  adapter. Assert `dispatcher.dispatch` is called with `payload.text` equal to the mock
  transcript.

---

## Open Questions

- **Transcript caching:** Cache `sourceRef → transcript` to avoid re-transcribing the
  same audio on retry? Deferred — start without caching.
- **Language hint per-tenant:** Some tenants may speak different languages. Could expose
  a per-tenant `whisper_language` secret. Low priority.
- **Max duration guard:** Enforce `stt.maxDurationSeconds` by checking the platform's
  reported duration before downloading/transcribing. Avoid spending compute on a 30-min
  voice memo.
- **GPU vs CPU:** The `faster-whisper-server` image supports both. GPU gives ~10x speedup.
  For CPU-only deployments, use the `tiny.en` model (lower quality but fast enough for
  short voice memos). Document both paths.
- **Whisper model selection:** `base.en` is the sweet spot for English (fast, accurate).
  For multilingual, use `base` or `small`. Configurable via `WHISPER_MODEL`.
