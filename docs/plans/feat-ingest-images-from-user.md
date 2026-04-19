# Feature Plan: Ingest Images from User (Go)

Goal: allow users to send photos/images through Telegram (and future Slack), have the trigger gateway download and normalise them, and forward image data to the running workload Pod so vision-capable agents can process the image alongside text.

The TS plan's design (base64-on-payload, per-adapter download helpers, optional auto-description for non-vision drivers) carries over verbatim. Only file paths, language, and the driver protocol change.

---

## How Telegram delivers images

When a user sends a photo, the `message` object contains a `photo` array. Each element is a `PhotoSize` with `file_id`, `width`, `height`, `file_size`. The last element is the largest. To download:

1. `GET /bot{token}/getFile?file_id={file_id}` → `result.file_path`
2. `GET /file/bot{token}/{file_path}` → raw image bytes

A `caption` field carries optional text. Documents with `mime_type` starting with `image/` are treated as photos.

Slack adapter is **not yet implemented in Go** (only telegram/webhook/cron live in `go/internal/trigger/`). Slack image ingestion is deferred until the Slack adapter exists; this plan covers Telegram and the cross-cutting payload changes.

---

## Changes

### 1. `go/internal/trigger/adapter.go`

Extend `TriggerPayload` with an optional `Images` field:

```go
type ImageAttachment struct {
    MimeType  string `json:"mimeType"`  // e.g. "image/jpeg"
    Data      string `json:"data"`      // base64-encoded bytes (no data-URI prefix)
    SourceRef string `json:"sourceRef"` // original filename or telegram file_id
}

type TriggerPayload struct {
    Text   string             `json:"text"`
    Source string             `json:"source"`
    Raw    any                `json:"raw"`
    Images []ImageAttachment  `json:"images,omitempty"`
}
```

Base64 keeps the payload JSON-serialisable across the driver wire format. Drivers that want raw bytes decode inline. URL-passing was rejected (would force the workload Pod to authenticate to Telegram/Slack — leaks bot tokens into containers).

---

### 2. `go/internal/trigger/adapter_telegram.go`

#### a. Extend `parsedTelegramUpdate`

```go
type parsedTelegramUpdate struct {
    // ... existing fields ...
    PhotoFileID       string
    Caption           string
    DocumentFileID    string
    DocumentMimeType  string
}
```

#### b. Extract in `parseTelegramUpdate`

After the existing `text` extraction (around `adapter_telegram.go:431`), pull image data from `msg`:

```go
if photos, ok := msg["photo"].([]any); ok && len(photos) > 0 {
    last := photos[len(photos)-1].(map[string]any)
    if id, ok := last["file_id"].(string); ok {
        photoFileID = id
    }
}
if cap, ok := msg["caption"].(string); ok {
    caption = cap
}
if doc, ok := msg["document"].(map[string]any); ok {
    if mime, ok := doc["mime_type"].(string); ok && strings.HasPrefix(mime, "image/") {
        if id, ok := doc["file_id"].(string); ok {
            documentFileID = id
            documentMimeType = mime
        }
    }
}
```

#### c. Add `downloadTelegramFile` helper

```go
// downloadTelegramFile fetches a Telegram file by file_id, returning base64-encoded
// bytes and a derived MIME type. Uses the adapter's httpClient so timeouts apply.
func downloadTelegramFile(
    ctx context.Context,
    httpClient *http.Client,
    apiBaseURL, botToken, fileID string,
) (data string, mimeType string, err error) {
    // Step 1: getFile
    getURL := fmt.Sprintf("%s/bot%s/getFile?file_id=%s", apiBaseURL, botToken, url.QueryEscape(fileID))
    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, getURL, nil)
    resp, err := httpClient.Do(req)
    if err != nil { return "", "", err }
    defer resp.Body.Close()

    var meta struct {
        OK     bool `json:"ok"`
        Result struct {
            FilePath string `json:"file_path"`
            FileSize int64  `json:"file_size"`
        } `json:"result"`
        Description string `json:"description"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil { return "", "", err }
    if !meta.OK { return "", "", fmt.Errorf("getFile: %s", meta.Description) }

    // Step 2: download
    dlURL := fmt.Sprintf("%s/file/bot%s/%s", apiBaseURL, botToken, meta.Result.FilePath)
    req2, _ := http.NewRequestWithContext(ctx, http.MethodGet, dlURL, nil)
    resp2, err := httpClient.Do(req2)
    if err != nil { return "", "", err }
    defer resp2.Body.Close()

    body, err := io.ReadAll(resp2.Body)
    if err != nil { return "", "", err }

    return base64.StdEncoding.EncodeToString(body), mimeFromPath(meta.Result.FilePath), nil
}

func mimeFromPath(path string) string {
    switch strings.ToLower(filepath.Ext(path)) {
    case ".jpg", ".jpeg": return "image/jpeg"
    case ".png":          return "image/png"
    case ".webp":         return "image/webp"
    case ".gif":          return "image/gif"
    default:              return "image/jpeg"
    }
}
```

#### d. Update `telegramUpdateToPayload`

Make it accept the adapter context (httpClient, apiBaseURL, botToken) so it can call `downloadTelegramFile`. Build the `Images` slice when `PhotoFileID` or `DocumentFileID` is set; set `Text = parsed.Caption` when caption present, otherwise `parsed.Text`.

Signature change:

```go
func (t *TelegramAdapter) telegramUpdateToPayload(
    ctx context.Context,
    cfg telegramConfig,
    parsed *parsedTelegramUpdate,
    raw map[string]any,
) TriggerPayload
```

(Alternatively keep it as a free function that accepts the deps — but moving it onto the adapter is cleaner since it now does I/O.)

If image download fails: log warning, dispatch the payload **without images** rather than failing the whole update. Symmetric with how the original plan handled it.

#### e. Wire into `pollLoop`

In the existing loop (`adapter_telegram.go:198`), replace:

```go
payload := telegramUpdateToPayload(parsed, update)
```

with:

```go
payload := t.telegramUpdateToPayload(ctx, cfg, parsed, update)
```

---

### 3. Driver Wire Format

The current driver (`go/internal/trigger/driver.go`) sends an HTTP POST to the workload's endpoint. To carry images, formalize the payload schema the driver POSTs:

```go
// What the driver posts to the workload Pod (e.g. POST /agent)
type DriverRequest struct {
    Text    string             `json:"text"`
    Source  string             `json:"source"`
    Images  []ImageAttachment  `json:"images,omitempty"`
    // ... future: audio, etc.
}
```

`driver.Send` already takes `payload TriggerPayload` (gateway.go:198). It just needs to serialize the new `Images` field, which is automatic via the existing JSON marshal — confirm `driver.Send` doesn't strip unknown fields.

Workload images are responsible for handling `images` as Anthropic content blocks (or rejecting/ignoring them). That contract is documented in the workload image's README, not enforced by the gateway.

---

### 4. Auto-description for non-vision workloads (deferred)

The TS plan included "Approach A: driver-level auto-description via vision model" for `driver-pi` (a Pi-specific driver). There is **no driver-pi in the Go port** — the only driver in `go/internal/trigger/driver.go` is the generic HTTP forwarder. Auto-description, if needed, becomes a per-workload concern (workload images call out to a vision API themselves).

If we later add a driver layer that knows about vision-capability:

- Add `driverOptions.autoDescribeImages: bool` to the trigger config.
- Add a small `vision_describe.go` that POSTs to Anthropic's vision API (or a self-hosted equivalent).
- Prepend the description to `payload.Text` before forwarding.

This is a follow-up. The base capability — getting image bytes onto the payload — does not depend on it.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `go/internal/trigger/adapter.go` | Modify | Add `ImageAttachment`, extend `TriggerPayload` |
| `go/internal/trigger/adapter_telegram.go` | Modify | Extract photo/document file IDs, `downloadTelegramFile`, build images on payload |
| `go/internal/trigger/adapter_telegram_test.go` | Modify | Tests for parse + download + payload assembly |
| `go/internal/trigger/driver.go` | Modify | Forward `Images` field on the wire (likely no change if JSON marshaling is generic) |
| (deferred) Slack adapter | — | Add when Slack adapter is implemented |
| (deferred) `vision_describe.go` | — | Auto-description for non-vision workloads |

---

## Sequencing

1. `adapter.go` — add types. No behaviour change.
2. `adapter_telegram.go` — parse extensions + `downloadTelegramFile`.
3. Wire into `pollLoop` and `telegramUpdateToPayload`.
4. Driver wire format check.

All sequential. Total ~150 lines of Go + tests.

---

## Test Strategy

`adapter_telegram_test.go` (extend the existing file):

- `parseTelegramUpdate` with a photo message → `PhotoFileID` is the last `PhotoSize`'s file_id; `Caption` extracted.
- `parseTelegramUpdate` with `mime_type=image/png` document → `DocumentFileID`/`DocumentMimeType` set.
- `parseTelegramUpdate` with text-only message → both file-id fields empty.
- `downloadTelegramFile` with mocked `httptest.Server` returning `getFile` JSON then raw bytes → returns correct base64 + mime.
- `telegramUpdateToPayload` with photo + caption → returns `Text=caption`, single-element `Images`.
- Integration: end-to-end via `httptest` mock server → `pollLoop` dispatches a payload with images.

All tests use `httptest.NewServer` (not real network).

---

## Open Questions / Deferred Decisions

- **Size cap:** large images (>5MB) as base64 may strain memory and bloat the driver POST. Add `maxImageBytes` (default 5MB) per adapter config in a follow-up; drop oversize images with a log warning.
- **Multiple images:** handled by the slice — Telegram delivers one photo per message.
- **Webhook adapter:** would need a multipart/base64 ingestion convention — out of scope.
- **Slack:** picked up when Slack adapter lands.
- **Image caching:** Telegram `file_id` is stable per bot; could cache `file_id → base64` to avoid re-downloads on retry. Defer.
- **Workload-side handling:** workload images opt in to images by including them as Anthropic vision blocks. Document this in the workload spec README rather than enforcing.
