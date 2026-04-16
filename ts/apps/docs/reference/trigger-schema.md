# Trigger Schema Reference

Complete reference for the trigger definition object passed to `defineTrigger()` or `POST /api/v1/triggers`.

## Top-Level Structure

```typescript
defineTrigger({
  name: string,                    // required
  type: TriggerType,               // required
  workload: string,                // required
  tenant: TenantMapping,           // required
  config: AdapterConfig,           // required
  driver?: string,
  driverOptions?: Record<string, unknown>,
  guards?: GuardStep[],
})
```

---

## `name`

- **Type:** `string`
- **Required:** yes

Unique trigger name.

## `type`

- **Type:** `"webhook" | "slack" | "telegram-poll" | "cron"`
- **Required:** yes

The adapter type. Determines which `config` shape is expected.

## `workload`

- **Type:** `string`
- **Required:** yes

Name of the workload to claim when the trigger fires.

---

## `tenant`

- **Type:** `TenantMapping`
- **Required:** yes

How to resolve the tenant ID from the incoming event.

### Static Mapping

Always maps to the same tenant:

```typescript
tenant: { static: "system-user" }
```

### Field Mapping

Extracts the tenant ID from the event:

```typescript
tenant: { fromField: "userId" }
tenant: { fromField: "usernameOrId", prefix: "tg-" }
```

| Field | Type | Description |
|-------|------|-------------|
| `fromField` | `string` | Field name to extract from the parsed event |
| `prefix` | `string` | Optional prefix prepended to the extracted value |

Available fields per adapter:

| Adapter | Fields |
|---------|--------|
| Webhook | Any JSON body field path |
| Slack | `userId`, `channelId`, `teamId` |
| Telegram | `chatId`, `userId`, `usernameOrId` |
| Cron | N/A (use `static`) |

---

## `config`

Adapter-specific configuration. Shape depends on `type`.

### Webhook Config

```typescript
config: {
  path: string,              // required — URL path (e.g., "/hooks/deploy")
  secret?: string,           // HMAC-SHA256 secret for signature verification
  rateLimit?: {
    max: number,             // max requests per window
    windowMs: number,        // window size in milliseconds
  },
}
```

The webhook validates `X-Hub-Signature-256` if `secret` is set.

### Slack Config

```typescript
config: {
  signingSecret: string,     // required — Slack signing secret
  botToken: string,          // required — Slack bot token (xoxb-...)
  eventTypes?: string[],     // event types to handle (default: all)
  rateLimit?: {
    max: number,
    windowMs: number,
  },
}
```

The adapter handles URL verification challenges automatically and verifies request signatures.

### Telegram Poll Config

```typescript
config: {
  botToken: string,              // required — Telegram bot token
  updateTypes?: string[],        // update types to process (default: all)
  pollTimeoutSeconds?: number,   // long-poll timeout (default: 30)
  apiBaseUrl?: string,           // custom Telegram API URL
}
```

The adapter long-polls `getUpdates` — no inbound endpoint required.

### Cron Config

```typescript
config: {
  schedule: string,                      // required — cron expression
  payload?: Record<string, unknown>,     // optional static payload
}
```

Standard cron syntax (e.g., `"0 2 * * *"` for 2 AM daily, `"*/5 * * * *"` for every 5 minutes).

---

## `driver`

- **Type:** `string`
- **Required:** no

Protocol driver package for formatting payloads before sending to the container.

Built-in drivers:

| Package | Protocol |
|---------|----------|
| `@boilerhouse/driver-claude-code` | Claude Code WebSocket bridge |
| `@boilerhouse/driver-openclaw` | OpenClaw control WebSocket |
| `@boilerhouse/driver-pi` | Pi agent WebSocket |

If omitted, payloads are sent as plain HTTP POST JSON to the container's first exposed port.

## `driverOptions`

- **Type:** `Record<string, unknown>`
- **Required:** no

Driver-specific configuration options.

---

## `guards`

- **Type:** `GuardStep[]`
- **Required:** no

Authorization guards executed before claiming an instance. Guards run as a chain — if any guard denies, the trigger is rejected.

```typescript
guards: [{
  guard: string,                           // guard package name
  guardOptions?: Record<string, unknown>,  // guard-specific config
}]
```

### Allowlist Guard

```typescript
{
  guard: "@boilerhouse/guard-allowlist",
  guardOptions: {
    tenantIds: ["tg-alice", "tg-bob"],   // allowed tenant IDs (case-insensitive)
    denyMessage: "Not authorized.",       // optional denial message
  },
}
```

### API Guard

```typescript
{
  guard: "@boilerhouse/guard-api",
  guardOptions: {
    url: "https://api.example.com/auth",  // authorization endpoint
    headers: {                             // optional request headers
      "Authorization": "Bearer token",
    },
    denyMessage: "Access denied.",         // optional fallback denial message
  },
}
```

The API guard POSTs `{ tenantId, source }` to the URL. Expected response: `{ ok: true }` or `{ ok: false, message: "reason" }`.

Fails closed: network errors, timeouts (3s), non-2xx responses, and malformed JSON all result in denial.
