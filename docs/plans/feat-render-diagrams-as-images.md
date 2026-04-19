# Render Diagrams as Images (Go)

**Goal:** Detect mermaid/graphviz/SVG diagram blocks in agent text responses, render them to PNG bytes via the kroki.io HTTP API, and send the resulting images to Telegram (and future Slack) using new image-send helpers.

**Architecture:** A new `go/internal/trigger/diagram_renderer.go` scans response text for fenced diagram blocks, POSTs each block to kroki.io, and returns `{cleanedText, []RenderedDiagram}`. The current Telegram reply path (inlined at `adapter_telegram.go:222-228`) is extracted into a `reply.go` helper that calls the renderer and dispatches images through a new `sendTelegramPhoto` function. Slack is deferred until the Slack adapter exists.

---

## Dependency Note

The current Telegram adapter sends replies *inline*:

```go
// adapter_telegram.go:222
if parsed.ChatID != nil {
    text := extractResponseText(result)
    if text != "" {
        if err := t.sendMessage(ctx, tgAPI, *parsed.ChatID, text); err != nil { ... }
    }
}
```

There is no `sendReply` abstraction. The first refactor in this plan extracts that into `reply.go` so diagram rendering, future Slack support, and reply-context routing (used by the wake-up plan) all share one place to inject behaviour.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `go/internal/trigger/diagram_renderer.go` | Create | Regex detect, kroki HTTP, returns cleaned text + image bytes |
| `go/internal/trigger/diagram_renderer_test.go` | Create | Detection regex, kroki httptest, output shape |
| `go/internal/trigger/adapter_telegram.go` | Modify | Add `sendTelegramPhoto`; replace inline `sendMessage` with `reply.SendTelegram` |
| `go/internal/trigger/reply.go` | Create | `SendTelegram(ctx, ...)`: render diagrams, send text, send photos sequentially |
| `go/internal/trigger/reply_test.go` | Create | End-to-end with mocked kroki + telegram |

---

## Why kroki.io

| Option | Pros | Cons |
|--------|------|------|
| `mmdc` (mermaid CLI) | Local | Needs Node + Chromium in container, ~500 MB |
| Headless Chrome | Full browser rendering | ~1 GB, complex lifecycle |
| mermaid.ink | Free, simple HTTP | Mermaid only |
| **kroki.io** | mermaid, graphviz, plantuml, svgbob, 30+ types; one HTTP POST | External dependency; diagram source leaves cluster |

Kroki is the only option that doesn't bloat the trigger gateway image. If diagram-source confidentiality matters, deploy `yuzutech/kroki` as an in-cluster Deployment and point `KROKI_URL` at it — same code, no external dependency. Plan keeps the default at `https://kroki.io`.

---

## Task 1: `diagram_renderer.go`

### Kroki API

- `POST https://{base}/{type}/{format}` with the raw diagram source as `text/plain`.
- Returns binary image bytes (`image/png` or `image/svg+xml`).
- Types we accept: `mermaid`, `graphviz` (alias `dot`), `plantuml`, `svgbob`, `svg` (passthrough).

### Detection

Standard markdown fenced blocks. Pattern (with multiline mode):

```
^```(mermaid|graphviz|dot|plantuml|svgbob|svg)\n([\s\S]*?)^```
```

In Go: `regexp.MustCompile("(?m)^\\x60{3}(mermaid|graphviz|dot|plantuml|svgbob|svg)\\n([\\s\\S]*?)^\\x60{3}")`.

### Types

```go
type DiagramType string
const (
    DiagramMermaid  DiagramType = "mermaid"
    DiagramGraphviz DiagramType = "graphviz"
    DiagramDot      DiagramType = "dot" // alias
    DiagramPlantUML DiagramType = "plantuml"
    DiagramSvgbob   DiagramType = "svgbob"
    DiagramSVG      DiagramType = "svg"
)

type RenderedDiagram struct {
    Source   string
    Type     DiagramType
    Bytes    []byte
    MimeType string // "image/png" | "image/svg+xml"
}

type DiagramRenderResult struct {
    CleanedText string             // text with all matched blocks removed
    Images      []RenderedDiagram  // one per successfully rendered block
}

type DiagramRendererConfig struct {
    BaseURL    string
    HTTPClient *http.Client
    Timeout    time.Duration
}

func DefaultDiagramRendererConfig() DiagramRendererConfig { ... }
```

### `ExtractAndRenderDiagrams(ctx, text, cfg) (DiagramRenderResult, error)`

1. Find all matches of the regex.
2. If none → return `{text, nil}`.
3. Strip all matched blocks from text. Collapse 3+ consecutive newlines into 2.
4. For each match in order:
   - `svg` → no kroki call; `Bytes = []byte(source)`, `MimeType = "image/svg+xml"`.
   - `dot` → render as `graphviz`.
   - else → POST to `{cfg.BaseURL}/{type}/png` with the source as `text/plain`. Read body. `MimeType = "image/png"`.
5. On per-diagram failure: log warn, skip (block already stripped from text).
6. Return result.

Failures don't propagate — partial output is better than no output.

---

## Task 2: `sendTelegramPhoto`

`go/internal/trigger/adapter_telegram.go` — add after `sendMessage`:

```go
func (t *TelegramAdapter) sendPhoto(
    ctx context.Context,
    tgAPI string,
    chatID int64,
    imageBytes []byte,
    mimeType, caption string,
) error {
    var body bytes.Buffer
    mw := multipart.NewWriter(&body)
    _ = mw.WriteField("chat_id", strconv.FormatInt(chatID, 10))
    if caption != "" {
        _ = mw.WriteField("caption", caption)
    }
    fw, _ := mw.CreateFormFile("photo", "diagram."+extForImageMime(mimeType))
    if _, err := fw.Write(imageBytes); err != nil { return err }
    _ = mw.Close()

    req, _ := http.NewRequestWithContext(ctx, http.MethodPost, tgAPI+"/sendPhoto", &body)
    req.Header.Set("Content-Type", mw.FormDataContentType())
    resp, err := t.httpClient.Do(req)
    if err != nil { return err }
    defer resp.Body.Close()
    _, _ = io.Copy(io.Discard, resp.Body)
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        return fmt.Errorf("telegram sendPhoto: status %d", resp.StatusCode)
    }
    return nil
}

func extForImageMime(m string) string {
    switch m {
    case "image/png":     return "png"
    case "image/svg+xml": return "svg"
    case "image/jpeg":    return "jpg"
    default:              return "png"
    }
}
```

Multipart is required — Telegram's `sendPhoto` doesn't accept binary in JSON.

Note: Telegram's `sendPhoto` may reject SVG. If kroki is configured for `svg` output (which it isn't by default in this plan — we always ask for PNG), SVG would need to be sent via `sendDocument` instead. Keep it simple: always render PNG via kroki, only the explicit `svg` block stays SVG. For SVG blocks, prefer `sendDocument` — covered by a small branch in the reply helper.

---

## Task 3: `reply.go`

```go
package trigger

import (
    "context"
    "log/slog"
)

type Reply struct {
    Adapter   string  // "telegram" (others later)
    ChatID    *int64  // telegram
    BotToken  string
    APIBaseURL string
    HTTPClient *http.Client
    Renderer  DiagramRendererConfig
    Log       *slog.Logger
}

// SendTelegram sends the agent's textual response to a Telegram chat,
// rendering any embedded diagram blocks into images.
func SendTelegram(ctx context.Context, t *TelegramAdapter, chatID int64, response any) error {
    text := extractResponseText(response)
    if text == "" { return nil }

    res, err := ExtractAndRenderDiagrams(ctx, text, DefaultDiagramRendererConfig())
    if err != nil {
        t.log.Warn("diagram render error", "error", err)
        // Fall through with original text.
        res = DiagramRenderResult{CleanedText: text}
    }

    tgAPI := fmt.Sprintf("%s/bot%s", t.cfg.APIBaseURL, t.cfg.BotToken)

    if res.CleanedText != "" {
        if err := t.sendMessage(ctx, tgAPI, chatID, res.CleanedText); err != nil {
            t.log.Warn("telegram sendMessage failed", "error", err)
        }
    }
    for _, img := range res.Images {
        if img.MimeType == "image/svg+xml" {
            if err := t.sendDocument(ctx, tgAPI, chatID, img.Bytes, img.MimeType, ""); err != nil {
                t.log.Warn("telegram sendDocument failed", "error", err)
            }
        } else {
            if err := t.sendPhoto(ctx, tgAPI, chatID, img.Bytes, img.MimeType, ""); err != nil {
                t.log.Warn("telegram sendPhoto failed", "error", err)
            }
        }
    }
    return nil
}
```

In `pollLoop` (`adapter_telegram.go:222`), replace the inline send with:

```go
if parsed.ChatID != nil {
    if err := SendTelegram(ctx, t, *parsed.ChatID, result); err != nil {
        t.log.Error("telegram reply failed", "error", err, "chat_id", *parsed.ChatID)
    }
}
```

This is the same hook the wake-up plan needs (see `feat-wake-up-tasks.md`'s `SendReply`). The two should agree on a single `Reply`/`SendTelegram` shape — implement once, both plans consume it.

---

## Task 4: Slack (deferred)

Slack's modern file upload is a 3-step flow:

1. `POST files.getUploadURLExternal` → `{ upload_url, file_id }`
2. `POST {upload_url}` with raw bytes
3. `POST files.completeUploadExternal` with `{ files: [{ id }], channel_id }`

When a Slack adapter lands, add `sendSlackImage` and a `SendSlack` reply variant. New scope on the bot token: `files:write`.

---

## Task 5: Behavior Summary

After this plan:

- Plain-text response → one telegram message, no diagrams.
- Mermaid block in response → text (with block stripped) message, then PNG photo.
- Response is *only* a diagram → no text message (skip empty), photo only.
- SVG block → `sendDocument` (Telegram doesn't render SVG inline).
- kroki failure on a single block → block stripped, image silently dropped, other blocks unaffected.
- kroki down entirely → text sent unchanged with diagram blocks intact (visible markdown). Acceptable degradation.

---

## Sequencing

1. `diagram_renderer.go` — standalone, mock kroki via `httptest`.
2. `sendTelegramPhoto` + `sendDocument` helpers — testable independently.
3. `reply.go` `SendTelegram` — wires 1+2.
4. Replace inline `sendMessage` call site in `pollLoop`.
5. (Follow-up) Slack adapter + `SendSlack`.

Items 1-2 in parallel. 3 depends on both. 4 depends on 3.

---

## Test Strategy

`diagram_renderer_test.go`:

- No diagram blocks → cleanedText unchanged, no images.
- Single mermaid block → 1 image, `image/png`, source kept on `RenderedDiagram.Source`.
- Block stripped from `cleanedText`; surrounding text preserved; trailing newlines collapsed.
- Multiple blocks → multiple images in document order.
- `dot` → kroki POST goes to `/graphviz/png`.
- Inline `svg` → no kroki call, bytes are UTF-8 of source, `image/svg+xml`.
- kroki returns 400 → block silently skipped, cleanedText still cleaned.

`reply_test.go`:

- Plain text → one `sendMessage` call.
- Text + mermaid → kroki call + sendMessage + sendPhoto, in that order.
- Mermaid only → no sendMessage, one sendPhoto.
- SVG → sendDocument not sendPhoto.
- All HTTP via `httptest.NewServer` mocks.

---

## Open Questions

- **Self-host kroki:** add `KROKI_URL` env var; default stays public. Document the `yuzutech/kroki` image for in-cluster deploy.
- **Image size limits:** Telegram `sendPhoto` accepts ≤10MB. Kroki rendered PNGs are normally <1MB; add a guard if it ever bites.
- **Caption handling:** the renderer currently emits photos with empty captions. Could pass the diagram label (e.g. `mermaid`) — defer.
- **Error logging visibility:** silent drop is operator-unfriendly. Add an o11y counter `boilerhouse_diagram_render_errors_total{type}`.
