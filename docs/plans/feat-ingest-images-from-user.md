# Feature Plan: Ingest Images from User

Goal: allow users to send photos/images through Telegram or Slack chat, have the trigger
layer download and normalise them, and forward image data to drivers (especially
driver-claude-code) so vision-capable agents can process the image alongside text.

---

## How Telegram and Slack deliver images

### Telegram

When a user sends a photo, the `message` object in the Update contains a `photo` array
instead of (or alongside) a `text` field. Each element is a `PhotoSize` object:

```json
{
  "file_id": "AgACAgIAAxkB...",
  "file_unique_id": "AQADqrExMx...",
  "width": 1280,
  "height": 720,
  "file_size": 98304
}
```

Telegram always provides multiple sizes; the last element is the largest. To download a
photo, the bot must:
1. Call `GET /bot{token}/getFile?file_id={file_id}` → receives `{ result: { file_path: "photos/file_0.jpg" } }`
2. Download from `https://api.telegram.org/file/bot{token}/{file_path}`

A `caption` field on the message carries optional text the user typed alongside the photo;
this maps to the existing `text` field in the payload.

Documents with `mime_type` starting with `image/` should be treated the same as photos
(users sometimes send images as files). The `document` field on `message` carries
`file_id`, `mime_type`, and `file_name`.

### Slack

Slack delivers file shares inside `message` events. When a file is attached the event
includes a `files` array:

```json
{
  "type": "message",
  "files": [
    {
      "id": "F12345",
      "name": "image.png",
      "mimetype": "image/png",
      "url_private": "https://files.slack.com/files-pri/T.../image.png",
      "url_private_download": "https://files.slack.com/files-pri/T.../download/image.png"
    }
  ]
}
```

Downloading requires an `Authorization: Bearer {botToken}` header because Slack's file
URLs are private. The `url_private_download` field is preferred; `url_private` also works.

---

## Changes per file

### 1. `packages/triggers/src/config.ts`

**What to change:** Extend `TriggerPayload` (lines 8-15) with an optional `images` field.

**New shape:**

```ts
export interface ImageAttachment {
  /** MIME type, e.g. "image/jpeg" */
  mimeType: string;
  /** Base64-encoded image bytes (no data-URI prefix). */
  data: string;
  /** Original filename or Telegram file_id, for logging/debugging. */
  sourceRef: string;
}

export interface TriggerPayload {
  text: string;
  source: "telegram" | "slack" | "webhook" | "cron";
  raw: unknown;
  /** Attached images, pre-downloaded and base64-encoded. Optional. */
  images?: ImageAttachment[];
}
```

Rationale for base64 rather than raw bytes: drivers communicate over JSON WebSocket
frames (see `driver-socket.ts`). Base64 keeps the payload JSON-serialisable without
introducing a separate binary transport. Drivers that want raw bytes can decode inline.
The alternative of passing a URL would require the driver or container to reach out to
Telegram/Slack APIs and re-authenticate, which leaks credentials into containers.

---

### 2. `packages/triggers/src/adapters/telegram-parse.ts`

**What to change:**

a. Extend `ParsedTelegramUpdate` (lines 8-16) with optional image fields:

```ts
export interface ParsedTelegramUpdate {
  // ... existing fields unchanged ...
  /** Largest available PhotoSize file_id, if the message contains a photo. */
  photoFileId?: string;
  /** Caption text supplied alongside a photo. */
  caption?: string;
  /** Document file_id + mime_type, if the message is an image document. */
  documentFileId?: string;
  documentMimeType?: string;
}
```

b. In `parseTelegramUpdate` (starting line 22), after the existing `text` extraction
(line 46), add photo/document extraction from the typed `message` object. Broaden the
inline type cast for `message` (line 38) to include:

```ts
photo?: Array<{ file_id: string; file_size?: number }>;
caption?: string;
document?: { file_id: string; mime_type?: string };
```

Then set:
- `photoFileId = message.photo?.at(-1)?.file_id`
- `caption = message.caption`
- `documentFileId`: set only when `message.document?.mime_type?.startsWith("image/")`
- `documentMimeType = message.document?.mime_type`

c. Add a new exported helper function `downloadTelegramFile`:

```ts
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  apiBaseUrl = "https://api.telegram.org",
): Promise<{ data: string; mimeType: string }>;
```

Implementation steps inside the function:
1. `GET {apiBaseUrl}/bot{token}/getFile?file_id={fileId}` — parse `result.file_path` and
   `result.file_size`.
2. `GET {apiBaseUrl}/file/bot{token}/{file_path}` — read body as `ArrayBuffer`.
3. Convert to base64 using `Buffer.from(buffer).toString("base64")` (available in Bun).
4. Derive `mimeType` from the file extension in `file_path` (`.jpg`→`image/jpeg`,
   `.png`→`image/png`, `.webp`→`image/webp`); fall back to `"image/jpeg"`.
5. Return `{ data, mimeType }`.

This function belongs in `telegram-parse.ts` alongside `sendTelegramMessage` so both
the poll adapter and any future webhook adapter can reuse it.

d. Update `telegramUpdateToPayload` (line 77-86) signature to `async` and accept a
`botToken` and `apiBaseUrl` so it can call `downloadTelegramFile`. The function should:
- Build `images: ImageAttachment[]` by downloading `photoFileId` or `documentFileId`
  when present.
- Set `text` to `parsed.caption ?? parsed.text ?? ""`.
- Include `images` on the payload only when the array is non-empty.

---

### 3. `packages/triggers/src/adapters/telegram-poll.ts`

**What to change:**

In `poll()`, the `telegramUpdateToPayload` call is currently synchronous. After the
change it becomes:

```ts
const payload = await telegramUpdateToPayload(parsed, update, botToken, apiBaseUrl);
```

No other structural changes are needed. Error handling: if `downloadTelegramFile` throws
(e.g. Telegram API down), catch it and log a warning, then dispatch the payload without
images rather than failing the entire update.

---

### 4. `packages/triggers/src/adapters/slack.ts`

**What to change:**

In `createSlackRoutes()` → the `event_callback` handler, after extracting `text`,
`channel`, and `user`, extract `files`:

```ts
const files = event.files as Array<{
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
  name?: string;
}> | undefined;
```

Add a new helper function `downloadSlackFile`:

```ts
async function downloadSlackFile(
  url: string,
  botToken: string,
  mimeType: string,
  name: string,
): Promise<ImageAttachment>
```

Steps:
1. `fetch(url, { headers: { Authorization: "Bearer " + botToken } })` — read as `ArrayBuffer`.
2. Base64-encode via `Buffer.from(buffer).toString("base64")`.
3. Return `{ data, mimeType, sourceRef: name }`.

Then build `images` from image-typed files, catching individual download errors with a
warn log, and include on `TriggerPayload` when non-empty.

---

### 5. `packages/driver-claude-code/src/claude-code.ts`

**What to change:**

In `send()`, extend the prompt message to include images when present:

```ts
ws.send({
  type: "prompt",
  text: payload.text,
  ...(payload.images && payload.images.length > 0 && { images: payload.images }),
});
```

The `images` field on the wire message is the same `ImageAttachment[]` structure. The
container bridge passes image data to Claude's vision API as content blocks.

Import `ImageAttachment` from `@boilerhouse/triggers` (must be exported from
`packages/triggers/src/index.ts`).

---

### 6. Image handling for non-vision drivers (Pi)

Pi does not have vision capability, but users will frequently send screenshots, photos,
and diagrams. Two approaches to handle this, which can coexist:

#### Approach A: Driver-level auto-description via vision model

The Pi driver calls a vision model (Haiku) to describe the image before sending the
text prompt to Pi. This happens transparently — the agent receives a text description
without needing to do anything.

**Changes to `packages/driver-pi/src/pi.ts`:**

In `send()`, before the `ws.send` call:

```ts
let promptText = payload.text;

if (payload.images && payload.images.length > 0) {
  const descriptions = await describeImagesViaVision(
    payload.images,
    config.options?.anthropicApiKey,
    config.options?.visionModel,
  );
  promptText = `${descriptions}\n\n${payload.text}`;
}

ws.send({ type: "prompt", text: promptText });
```

**New helper in `packages/driver-pi/src/describe-images.ts`:**

```ts
import Anthropic from "@anthropic-ai/sdk";

export async function describeImagesViaVision(
  images: ImageAttachment[],
  apiKey: string,
  model = "claude-haiku-4-5-20251001",
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const blocks: string[] = [];

  for (const img of images) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: img.mimeType, data: img.data },
          },
          {
            type: "text",
            text: "Describe this image in detail. If it contains text, transcribe it exactly. If it's a diagram or chart, describe the structure and relationships.",
          },
        ],
      }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    blocks.push(`[Image: ${img.sourceRef}]\n${text}`);
  }

  return blocks.join("\n\n");
}
```

Uses Haiku by default — fast, cheap (~$0.001/image), good enough for description.
Configurable per-workload via `driverOptions`:

```ts
driverOptions: {
  gatewayToken: "...",
  anthropicApiKey: secret("ANTHROPIC_API_KEY"),
  visionModel: "claude-haiku-4-5-20251001",
}
```

**Pros:** Automatic, agent doesn't need to think about it, works for all image types.
**Cons:** Burns a vision call on every image whether or not the agent needs it; agent
can't control the prompt or ask follow-up questions about the image.

#### Approach B: Vision skill the agent can invoke on demand

Give the agent a tool/skill it can call to describe images. The images are stored
(temporarily, in-memory or on the instance overlay) and the agent invokes a
`describe_image` tool when it wants to understand one.

**How it works:**

1. When `payload.images` is present, the Pi driver writes the image data to a temp
   directory on the instance's overlay filesystem (`/tmp/images/{sourceRef}.{ext}`).
2. The prompt text includes a notice: `[User sent {n} image(s): {sourceRef1}, {sourceRef2}. Use the describe_image tool to view them.]`
3. The agent's tool set includes a `describe_image` tool that takes a `sourceRef` and
   an optional `prompt`, calls a vision model, and returns the description.

**Where the tool lives:** This is an MCP tool or bridge-level tool exposed by the Pi
container's bridge server. The bridge already handles the WebSocket protocol — it would
add a new message type:

```
→ { type: "describe_image", sourceRef: "photo_123.jpg", prompt?: "What text is visible?" }
← { type: "image_description", sourceRef: "photo_123.jpg", text: "The image shows..." }
```

The bridge calls the Anthropic API server-side (or proxies through the Boilerhouse API)
to perform the vision call.

**Pros:** Agent controls when/whether to describe, can ask targeted questions ("what
does the error message say?" vs "describe the full layout"), avoids wasted vision calls,
composes with the skill pack architecture.
**Cons:** Requires Pi bridge changes (new message type), agent must know to use the tool.

#### Recommendation: Start with A, add B later

> TODO: Lets do A, ignore B. A means the agent always gets description of an image no matter what.

Approach A is simpler and requires no bridge protocol changes — it's entirely within
`driver-pi`. Ship this first so images work immediately. Approach B is a better long-term
design and should be added as a follow-up, potentially as part of the skill pack work.

When B is available, A becomes optional — operators can disable auto-description via
`driverOptions.autoDescribeImages: false` when the agent has the skill.

**Fallback:** If the vision API call fails (no API key, rate limit, network error), catch
the error, log a warning, and send the original `payload.text` with a note:
`[User sent an image but it could not be processed]`. Better than a hard failure.

#### Tests for Approach A

**`packages/driver-pi/src/describe-images.test.ts`:**
- Mock Anthropic SDK client. Assert correct message shape (image + text content blocks).
- Assert response text is extracted and formatted with `[Image: ref]` headers.
- Assert API error is caught gracefully — returns fallback text.
- Assert empty images array returns empty string.

**`packages/driver-pi/src/pi.test.ts` additions:**
- Payload with images + valid API key → `describeImagesViaVision` called, text prepended.
- Payload with images + no API key → warning logged, original text sent with notice.
- Payload without images → prompt sent unchanged.

---

### 7. `packages/triggers/src/index.ts`

Export the new `ImageAttachment` type alongside `TriggerPayload`.

---

## Sequencing

1. `config.ts` — add `ImageAttachment` and extend `TriggerPayload`. Type foundation.
2. `telegram-parse.ts` — extend `ParsedTelegramUpdate`, add `downloadTelegramFile`,
   make `telegramUpdateToPayload` async.
3. `telegram-poll.ts` — await the now-async `telegramUpdateToPayload`.
4. `slack.ts` — add `downloadSlackFile` and populate `images` in the payload.
5. `index.ts` — export `ImageAttachment`.
6. `claude-code.ts` — forward images in the prompt message (vision-native path).
7. `driver-pi/src/describe-images.ts` + `pi.ts` — vision auto-description for Pi (Approach A).
8. (Follow-up) Pi bridge `describe_image` tool — agent-controlled vision skill (Approach B).

Items 2-4 can be done in parallel. Items 6-7 can be done in parallel. All depend on item 1.

---

## Test strategy

### Unit tests for `telegram-parse.ts`

Create `packages/triggers/src/adapters/telegram-parse.test.ts`:

- `parseTelegramUpdate` with a photo message: assert `photoFileId` equals the
  `file_id` of the last `PhotoSize` and `caption` is extracted.
- `parseTelegramUpdate` with a document of `mime_type: "image/png"`: assert
  `documentFileId` and `documentMimeType` are set.
- `parseTelegramUpdate` with a text-only message: assert `photoFileId` and
  `documentFileId` are `undefined`.
- `downloadTelegramFile`: mock `fetch`. Two calls: one returning
  `{ ok: true, result: { file_path: "photos/f.jpg" } }`, one returning an `ArrayBuffer`.
  Assert returned `data` is correct base64 and `mimeType` is `"image/jpeg"`.
- `telegramUpdateToPayload` with a photo: mock `downloadTelegramFile`, assert returned
  `TriggerPayload` has a non-empty `images` array.

### Unit tests for `slack.ts`

Extend `packages/triggers/src/adapters/slack.test.ts`:

- Event with a `files` array containing an image: mock `fetch` to return image bytes with
  the Authorization header. Assert dispatcher receives payload with non-empty `images`.
- Event with a non-image file (e.g. `mimetype: "application/pdf"`): assert `images` absent.
- Image download failure: mock fetch to reject; assert dispatch still proceeds without images.

---

## Open questions / deferred decisions

- **Size cap:** Large images (>5 MB) as base64 may cause WebSocket frame or memory issues.
  Add a configurable `maxImageBytes` per-trigger in a follow-up.
- **Multiple images:** Already handled by the `images` array.
- **Webhook adapter:** Not modified here — a follow-up can formalise a multipart/base64 convention.
- **Container-side claude-code bridge:** Must be updated to accept `images` in `prompt`
  messages and convert them to Anthropic vision content blocks. Hard dependency for
  end-to-end vision but outside scope of this plan.
- **Vision model cost:** Haiku auto-description costs ~$0.001/image. For high-volume
  deployments, consider per-tenant rate limits. When Approach B (agent-invoked skill)
  is available, operators can disable auto-description to avoid unnecessary calls.
- **Vision prompt tuning:** The default prompt is general-purpose. Operators may want
  domain-specific prompts (e.g. "Extract all UI elements and their states"). Configurable
  via `driverOptions.visionPrompt` in Approach A; the agent controls the prompt directly
  in Approach B.
- **Caching:** Repeated sends of the same image could be cached by
  `ImageAttachment.sourceRef` (Telegram `file_id` is stable). Deferred — start without
  caching, add if cost or latency is a concern.
- **Approach B (vision skill) design:** The Pi bridge protocol change (`describe_image`
  message type) needs its own plan. Key questions: does the bridge call the Anthropic API
  directly (needs API key in container) or proxy through Boilerhouse API (adds a new
  internal endpoint)? Proxying is cleaner — keeps secrets out of containers.
