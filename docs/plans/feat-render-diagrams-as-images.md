# Render Diagrams as Images — Implementation Plan

**Goal:** Detect mermaid/graphviz/SVG diagram blocks in agent text responses, render them to PNG bytes via the kroki.io HTTP API, and send the resulting images to Telegram/Slack using new per-adapter image-send functions.

**Architecture:** A new `packages/triggers/src/diagram-renderer.ts` module scans response text for fenced diagram blocks, POSTs each block to kroki.io, and returns `{ cleanedText: string, images: RenderedDiagram[] }`. The existing `sendReply` function in `reply.ts` is extended to call the renderer and dispatch images through new `sendTelegramPhoto` and `sendSlackImage` functions added to the respective adapter files. The feature builds on top of the "send images over chat" capability — the image-send adapter functions should be implemented (or stubbed) before this feature is fully wired.

---

## Dependency Note

This plan has one hard external dependency: **"send images over chat"** — the Telegram `sendPhoto` endpoint and the Slack `files.uploadV2` endpoint must exist as callable functions before Task 4 (wiring `sendReply`) can be fully tested end-to-end. Tasks 1–3 (detection + rendering + per-adapter image functions) are independently testable and should be completed first.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/triggers/src/diagram-renderer.ts` | Create | Regex detection of diagram blocks; HTTP render via kroki.io; returns cleaned text + image buffers |
| `packages/triggers/src/diagram-renderer.test.ts` | Create | Unit tests for detection regex, kroki.io fetch stub, output shape |
| `packages/triggers/src/adapters/telegram-parse.ts` | Modify | Add `sendTelegramPhoto(botToken, chatId, pngBytes, caption?, apiBaseUrl?)` |
| `packages/triggers/src/adapters/slack.ts` | Modify | Add `postSlackImage(botToken, channel, pngBytes, filename, altText?)` |
| `packages/triggers/src/adapters/telegram-parse.test.ts` | Create | Unit tests for `sendTelegramPhoto` (fetch mock) |
| `packages/triggers/src/adapters/slack.test.ts` | Modify | Add unit tests for `postSlackImage` (fetch mock) |
| `packages/triggers/src/reply.ts` | Modify | Call `extractAndRenderDiagrams`; send images after text; strip diagram blocks from text |
| `packages/triggers/src/reply.test.ts` | Create | Unit tests for `sendReply` with diagram-containing responses (all fetch mocked) |

---

## Rendering Options Rationale

| Option | Pros | Cons |
|--------|------|------|
| `@mermaid-js/mermaid-cli` (mmdc) | Local, no network, full mermaid support | Requires Node + Chromium in container, adds ~500 MB image weight |
| Headless Chrome / Playwright | Full browser rendering, flexible | Very heavy dependency (~1 GB), complex lifecycle, slow cold start |
| mermaid.ink API | Free, mermaid-only, simple HTTP | Only mermaid; external service; no graphviz/plantuml |
| **kroki.io** | Supports mermaid, graphviz, plantuml, svgbob, and 30+ others; simple HTTP POST; no install | External service dependency; free tier has no SLA; diagram source leaves the server |

**Recommendation: kroki.io.** The containerized Boilerhouse deployment does not carry a Chromium binary, and adding one would significantly inflate the image. kroki.io covers all relevant diagram types with a single HTTP call and zero added dependencies. If self-hosting becomes necessary, kroki.io is open-source and can be deployed as a sidecar (`yuzutech/kroki` Docker image).

---

## Task 1: Diagram detection + rendering module

**File:** `packages/triggers/src/diagram-renderer.ts`

### What kroki.io expects

- Endpoint: `POST https://kroki.io/{diagramType}/{outputFormat}`
- Body: the raw diagram source as plain text (`Content-Type: text/plain`)
- Response: binary image bytes (`image/png` or `image/svg+xml`)
- Supported types: `mermaid`, `graphviz`, `svgbob`, `plantuml`
- Example: `POST https://kroki.io/mermaid/png` with body `graph LR\n  A --> B`

SVG fenced blocks that are already valid XML are returned as-is as `image/svg+xml` bytes without a kroki.io round-trip.

### Diagram block detection regex

Standard markdown fenced code blocks with language tags: `mermaid`, `graphviz`, `dot` (alias for graphviz), `plantuml`, `svgbob`, `svg`.

Pattern: `` /^```(mermaid|graphviz|dot|plantuml|svgbob|svg)\n([\s\S]*?)^```/gm ``

### Data types

```typescript
export type DiagramType = "mermaid" | "graphviz" | "dot" | "plantuml" | "svgbob" | "svg";

export interface RenderedDiagram {
  source: string;
  type: DiagramType;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/svg+xml";
}

export interface DiagramRenderResult {
  cleanedText: string;  // response text with all diagram fenced blocks removed
  images: RenderedDiagram[];  // one entry per successfully rendered diagram
}
```

### `extractAndRenderDiagrams(text: string): Promise<DiagramRenderResult>`

Logic:
1. Run the regex against `text`, collect all matches.
2. If no matches, return `{ cleanedText: text, images: [] }` immediately.
3. Strip all matched diagram blocks from text (regardless of render outcome). Collapse triple+ newlines to double.
4. For each match, render via kroki.io (`POST /mermaid/png`, `dot` maps to `graphviz`, `svg` passes through as UTF-8 bytes with `image/svg+xml` MIME). Catch render errors, skip failed diagrams silently.
5. Return `{ cleanedText, images }`.

### Tests (`diagram-renderer.test.ts`)

- No diagram blocks → cleanedText unchanged, images empty.
- Single mermaid block → 1 image with `type: "mermaid"`, `mimeType: "image/png"`.
- Block stripped from cleanedText; surrounding text preserved.
- Multiple blocks → multiple images in order.
- `dot` type → krokiType resolves to `graphviz` endpoint.
- `svg` block → no fetch call, bytes are UTF-8 encoded SVG, `mimeType: "image/svg+xml"`.
- kroki.io returns 400 → block silently skipped, cleanedText still cleaned.

All tests use mocked `fetch`.

---

## Task 2: Telegram — `sendTelegramPhoto`

**File:** `packages/triggers/src/adapters/telegram-parse.ts`

Add after the existing `sendTelegramMessage` function:

```typescript
export async function sendTelegramPhoto(
  botToken: string,
  chatId: number,
  imageBytes: Uint8Array,
  caption?: string,
  apiBaseUrl = "https://api.telegram.org",
): Promise<void>
```

Implementation: build a `FormData` with `chat_id`, `photo` (Blob of `image/png`, filename `diagram.png`), and optional `caption`. POST to `/bot{token}/sendPhoto`.

Note: multipart is required — Telegram's sendPhoto endpoint does not accept binary via JSON.

### Tests (`telegram-parse.test.ts`)

- POSTs to the correct `/sendPhoto` URL.
- Uses custom `apiBaseUrl` when provided.
- Includes `caption` in form data when provided.
- Does not include `caption` field when omitted.

---

## Task 3: Slack — `postSlackImage`

**File:** `packages/triggers/src/adapters/slack.ts`

Slack's modern file upload requires a three-step flow (legacy `files.upload` was deprecated in 2024):

1. `POST files.getUploadURLExternal` with `filename` and `length` → get `upload_url` and `file_id`.
2. `POST {upload_url}` with raw bytes (`application/octet-stream`).
3. `POST files.completeUploadExternal` with `files: [{ id: file_id }]` and `channel_id`.

```typescript
export async function postSlackImage(
  botToken: string,
  channel: string,
  imageBytes: Uint8Array,
  filename: string,
  altText?: string,
): Promise<void>
```

Throws typed errors if step 1 or step 3 returns `{ ok: false }`.

New scope required on the Slack bot token: `files:write`.

### Tests (add to `slack.test.ts`)

- All three fetch calls happen in order (getUploadURLExternal → upload URL → completeUploadExternal).
- Throws if `getUploadURLExternal` returns `ok: false`.

---

## Task 4: Wire diagram rendering into `sendReply`

**File:** `packages/triggers/src/reply.ts`

### Behavior

1. Extract text from `agentResponse` (existing logic).
2. Call `extractAndRenderDiagrams(text)`.
3. Send `cleanedText` as text message. If empty after stripping, skip the text message.
4. For each `RenderedDiagram` in `images`, call the adapter-specific image-send function sequentially.
5. For `webhook` and `cron` adapters, images are silently dropped.

### Imports to add

```typescript
import { sendTelegramPhoto } from "./adapters/telegram-parse";
import { postSlackImage } from "./adapters/slack";
import { extractAndRenderDiagrams } from "./diagram-renderer";
```

### Post-processing: ordering

Cleaned text is sent first, then images sequentially. Text provides context above the images in the chat. An all-diagram response (empty cleaned text) sends only images.

### Tests (`reply.test.ts`)

- Plain text (no diagrams) → only `sendMessage` called, no `sendPhoto`.
- Mermaid block in response → kroki.io called, `sendMessage` called with stripped text, `sendPhoto` called.
- Response is only a diagram block → `sendMessage` NOT called (no blank message), `sendPhoto` called.
- Slack adapter → getUploadURLExternal and completeUploadExternal called for diagram.
- `webhook` adapter with diagram → no error thrown, diagram silently dropped.

All tests mock `fetch`.

---

## Task 5: Export from `index.ts`

**File:** `packages/triggers/src/index.ts`

Add:

```typescript
export { extractAndRenderDiagrams } from "./diagram-renderer";
export type { RenderedDiagram, DiagramRenderResult, DiagramType } from "./diagram-renderer";
export { sendTelegramPhoto } from "./adapters/telegram-parse";
export { postSlackImage } from "./adapters/slack";
```

---

## Sequencing

1. `diagram-renderer.ts` — standalone, no dependencies on other new code.
2. `sendTelegramPhoto` + `postSlackImage` — can be done in parallel with Task 1.
3. Wire `sendReply` — depends on Tasks 1-2 being complete.
4. Export from `index.ts` — final cleanup step.

---

## Open Questions

- **kroki.io self-hosting:** If diagram source confidentiality is a concern, deploy the `yuzutech/kroki` Docker image as a sidecar. Add `krokiBaseUrl` to trigger config and pass it through to `extractAndRenderDiagrams`. This is a follow-up config addition — the default stays `https://kroki.io`.
- **Image size limits:** Telegram `sendPhoto` accepts up to 10 MB. Large SVG files decoded and re-encoded are unlikely to exceed this, but should be documented.
- **Error logging:** The renderer silently drops failed diagrams. Consider emitting a structured log entry so operators can detect systematic kroki.io failures without user reports.
