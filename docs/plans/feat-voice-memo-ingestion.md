# Feature Plan: Voice Memo Ingestion (Go)

Speech-to-text pipeline for voice messages from Telegram (and future Slack). Each adapter downloads the audio and passes it to a shared, platform-agnostic transcription service backed by self-hosted Whisper.

The TS-era design carries over: shared transcription helper, base64-on-payload, transcript replaces `Text` before dispatch. Only paths and language change. Slack is deferred — no Slack adapter in the Go port yet.

---

## Architecture

```
Telegram adapter
  → parsed.VoiceFileID detected
  → downloadTelegramVoice(ctx, httpClient, apiBase, botToken, fileID)
     → returns { data: base64, mimeType: "audio/ogg" }
  → transcribeAudio(ctx, data, mimeType, sttCfg)
     → POST → http://whisper.boilerhouse.svc:8000/v1/audio/transcriptions
     → returns transcript string
  → payload.Text = transcript (or transcript + "\n\n" + caption)
  → handler dispatches normally — workload sees text, doesn't know it came from audio
```

Whisper runs as a separate Deployment + Service in `boilerhouse` namespace. Internal-only ClusterIP — no public exposure, no API keys.

---

## Self-Hosted Whisper

### Deployment

`config/deploy/whisper.yaml` (new):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: whisper
  namespace: boilerhouse
spec:
  replicas: 1
  selector: { matchLabels: { app: whisper } }
  template:
    metadata: { labels: { app: whisper } }
    spec:
      containers:
        - name: whisper
          image: fedirz/faster-whisper-server:latest
          ports: [{ containerPort: 8000 }]
          env:
            - { name: WHISPER__MODEL, value: Systran/faster-whisper-base.en }
          resources:
            limits: { memory: 4Gi, cpu: 2 }
---
apiVersion: v1
kind: Service
metadata: { name: whisper, namespace: boilerhouse }
spec:
  selector: { app: whisper }
  ports: [{ port: 8000, targetPort: 8000 }]
```

The `fedirz/faster-whisper-server` image speaks the OpenAI-compatible `/v1/audio/transcriptions` endpoint. GPU support requires nvidia device plugin + GPU node — document but don't require.

CPU fallback: `Systran/faster-whisper-tiny.en` model gives acceptable quality for short voice memos and runs on the CPU footprint above.

### Configuration (env on the trigger gateway pod)

| Env var | Purpose | Default |
|---------|---------|---------|
| `WHISPER_URL` | Base URL | `http://whisper.boilerhouse.svc:8000` |
| `WHISPER_MODEL` | Model name in requests | `whisper-1` |
| `WHISPER_LANGUAGE` | Language hint (ISO 639-1) | (auto-detect) |

`cmd/trigger/main.go` reads these and passes them into adapters via the gateway.

---

## Payload Extension

### `go/internal/trigger/adapter.go`

Extend `TriggerPayload` symmetrically with `ImageAttachment`. (If the images plan lands first, this just adds the audio field.)

```go
type AudioAttachment struct {
    MimeType  string `json:"mimeType"`
    Data      string `json:"data"`      // base64
    Duration  int    `json:"duration,omitempty"` // seconds
    SourceRef string `json:"sourceRef"`
}

type TriggerPayload struct {
    Text   string             `json:"text"`
    Source string             `json:"source"`
    Raw    any                `json:"raw"`
    Images []ImageAttachment  `json:"images,omitempty"`
    Audio  []AudioAttachment  `json:"audio,omitempty"`
}
```

`Audio` on the payload is mostly for diagnostics/audit — by the time downstream code sees the payload, `Text` is already the transcript. We could omit `Audio` entirely; including it is cheap and lets future workloads opt to re-process the raw audio.

---

## Shared STT Client

### `go/internal/trigger/stt.go` (new)

```go
package trigger

import (
    "bytes"
    "context"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "mime/multipart"
    "net/http"
    "os"
    "time"
)

type STTConfig struct {
    URL       string
    Model     string
    Language  string
    Timeout   time.Duration
    HTTPClient *http.Client
}

func DefaultSTTConfig() STTConfig {
    cfg := STTConfig{
        URL:      envOr("WHISPER_URL", "http://whisper.boilerhouse.svc:8000"),
        Model:    envOr("WHISPER_MODEL", "whisper-1"),
        Language: os.Getenv("WHISPER_LANGUAGE"),
        Timeout:  60 * time.Second,
    }
    cfg.HTTPClient = &http.Client{Timeout: cfg.Timeout}
    return cfg
}

func envOr(k, def string) string { v := os.Getenv(k); if v == "" { return def }; return v }

// TranscribeAudio sends base64-encoded audio to a self-hosted Whisper service
// using the OpenAI-compatible /v1/audio/transcriptions endpoint.
func TranscribeAudio(ctx context.Context, audioB64, mimeType string, cfg STTConfig) (string, error) {
    raw, err := base64.StdEncoding.DecodeString(audioB64)
    if err != nil { return "", fmt.Errorf("decode audio: %w", err) }

    var body bytes.Buffer
    mw := multipart.NewWriter(&body)
    fw, _ := mw.CreateFormFile("file", "audio."+extForMime(mimeType))
    if _, err := fw.Write(raw); err != nil { return "", err }
    _ = mw.WriteField("model", cfg.Model)
    if cfg.Language != "" { _ = mw.WriteField("language", cfg.Language) }
    _ = mw.Close()

    req, err := http.NewRequestWithContext(ctx, http.MethodPost,
        cfg.URL+"/v1/audio/transcriptions", &body)
    if err != nil { return "", err }
    req.Header.Set("Content-Type", mw.FormDataContentType())

    resp, err := cfg.HTTPClient.Do(req)
    if err != nil { return "", err }
    defer resp.Body.Close()

    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        b, _ := io.ReadAll(resp.Body)
        return "", fmt.Errorf("whisper status %d: %s", resp.StatusCode, string(b))
    }
    var out struct{ Text string `json:"text"` }
    if err := json.NewDecoder(resp.Body).Decode(&out); err != nil { return "", err }
    return out.Text, nil
}

func extForMime(m string) string {
    switch m {
    case "audio/ogg", "audio/oga", "audio/opus": return "ogg"
    case "audio/webm":                            return "webm"
    case "audio/mp4":                             return "m4a"
    case "audio/mpeg":                            return "mp3"
    case "audio/wav", "audio/x-wav":              return "wav"
    case "audio/flac":                            return "flac"
    default:                                      return "ogg"
    }
}
```

This is platform-agnostic — adapters call it with raw base64 + MIME and a config.

---

## Telegram Adapter Changes

### `go/internal/trigger/adapter_telegram.go`

#### Parse

Add to `parsedTelegramUpdate`:

```go
VoiceFileID   string
VoiceDuration int
```

In `parseTelegramUpdate`:

```go
if voice, ok := msg["voice"].(map[string]any); ok {
    if id, ok := voice["file_id"].(string); ok {
        voiceFileID = id
    }
    if d, ok := getNumber(voice["duration"]); ok {
        voiceDuration = int(d)
    }
}
```

#### Download helper

```go
// downloadTelegramVoice fetches a Telegram voice file as base64.
func downloadTelegramVoice(
    ctx context.Context,
    httpClient *http.Client,
    apiBaseURL, botToken, fileID string,
) (data string, mimeType string, err error)
```

Identical structure to `downloadTelegramFile` from the images plan; voice files always come back as `audio/ogg`.

#### Wire into payload

In `telegramUpdateToPayload` (now adapter-method, see images plan), if `VoiceFileID != ""`:

```go
data, mime, err := downloadTelegramVoice(ctx, t.httpClient, cfg.APIBaseURL, cfg.BotToken, parsed.VoiceFileID)
if err != nil {
    t.log.Warn("voice download failed", "error", err, "file_id", parsed.VoiceFileID)
} else {
    transcript, err := TranscribeAudio(ctx, data, mime, t.sttCfg)
    if err != nil {
        t.log.Warn("transcription failed", "error", err)
    } else {
        if parsed.Text != "" {
            payload.Text = transcript + "\n\n" + parsed.Text
        } else {
            payload.Text = transcript
        }
        payload.Audio = append(payload.Audio, AudioAttachment{
            MimeType: mime, Data: data,
            Duration: parsed.VoiceDuration,
            SourceRef: parsed.VoiceFileID,
        })
    }
}
```

`t.sttCfg` is set in `NewTelegramAdapter` from `DefaultSTTConfig()` (with optional override from trigger config).

---

## Slack (deferred)

When the Slack adapter lands, voice clips arrive as `files[]` entries with `subtype: "slack_audio"` or `mimetype: "audio/webm"`. Pattern:

```go
for _, f := range filesWithMimePrefix("audio/") {
    raw, _ := downloadSlackFile(...)
    transcript, _ := TranscribeAudio(ctx, raw.Data, raw.MimeType, sttCfg)
    text = transcript + (text == "" ? "" : "\n\n" + text)
}
```

No new interfaces needed.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `go/internal/trigger/adapter.go` | Modify | `AudioAttachment` + payload extension |
| `go/internal/trigger/stt.go` | Create | `TranscribeAudio` shared client |
| `go/internal/trigger/stt_test.go` | Create | mocked Whisper httptest |
| `go/internal/trigger/adapter_telegram.go` | Modify | Voice parse + download + transcribe |
| `go/internal/trigger/adapter_telegram_test.go` | Modify | Voice end-to-end with httptest |
| `config/deploy/whisper.yaml` | Create | Whisper Deployment + Service |
| `config/deploy/kustomization.yaml` | Modify | Add `whisper.yaml` (or keep optional) |
| `cmd/trigger/main.go` | Modify | Read `WHISPER_*` env, pass into adapters |

---

## Sequencing

1. `adapter.go` audio types.
2. `stt.go` + `stt_test.go` (mocked whisper).
3. `whisper.yaml` Deployment.
4. Telegram parse + download + wire transcription.
5. cmd/trigger env wiring.

Items 2-3 in parallel. Item 4 depends on 1+2.

---

## Error Handling

| Failure | Policy |
|---------|--------|
| Voice download fails | Log warn, dispatch with empty text (or original caption). Don't block adapter. |
| Whisper unreachable | Log warn, skip update. Better to miss than dispatch with empty text. |
| Whisper returns error | Log warn, skip update. |
| Whisper times out (>60s) | Log warn, skip update. |

All non-fatal to the poll loop. Add o11y counter `boilerhouse_stt_transcribe_errors_total{reason}` via the existing `go/internal/o11y/` package.

---

## Test Strategy

`stt_test.go`:

- Mock Whisper via `httptest.NewServer` returning `{"text": "hello world"}`. Assert the multipart body contains `file` and `model`. Assert returned string matches.
- Mock returning 500 → error contains status.
- Cancel context mid-call → returns context error.
- `extForMime` table test for common MIMEs.

`adapter_telegram_test.go`:

- Parse a voice update → `VoiceFileID` extracted.
- Mock Telegram `getFile` + audio bytes + Whisper → end-to-end yields a payload with `Text=transcript` and `Audio` populated.

---

## Open Questions

- **Transcript caching:** keyed by `sourceRef → transcript` to avoid re-transcribing on retry. Defer.
- **Per-tenant language hint:** Could be a per-trigger config field. Low priority.
- **Max duration guard:** check `parsed.VoiceDuration` before downloading to avoid wasting compute on a 30-min memo. Add an env `MAX_VOICE_SECONDS` (default 300).
- **GPU vs CPU:** image supports both. Document `nvidia.com/gpu: 1` resource request for GPU clusters.
- **Audio in payload:** kept for now. If memory pressure becomes a problem, drop it after transcription and keep only `sourceRef` for audit.
