# Triggers

Triggers connect external events to Boilerhouse instances. When a message arrives from Slack, a webhook fires, or a cron schedule ticks, the trigger system automatically claims an instance for the appropriate tenant, forwards the event, and returns the response.

## Overview

The trigger flow has six steps:

1. **Receive** -- an adapter receives the external event (HTTP webhook, Telegram long-poll, cron tick)
2. **Resolve tenant** -- the tenant ID is extracted from the event payload using a configurable mapping
3. **Run guards** -- a guard chain runs for authorization, short-circuiting on the first denial
4. **Claim instance** -- an instance is claimed for the resolved tenant (from a warm pool if available, or cold-started)
5. **Forward event** -- a driver sends the normalized payload to the instance over WebSocket or HTTP
6. **Return response** -- the driver collects the instance's response and returns it to the event source

## Defining Triggers

Triggers are defined in `.trigger.ts` files using the `defineTrigger` function:

```typescript
import { defineTrigger } from "@boilerhouse/triggers";

export default defineTrigger({
  name: "my-webhook",
  type: "webhook",
  workload: "my-agent",
  tenant: { fromField: "body.userId", prefix: "user-" },
  config: {
    path: "/hooks/my-agent",
  },
});
```

Place trigger files in your workloads directory alongside workload definitions. The trigger gateway loads them at startup.

## Built-in Adapters

### Webhook

Receives HTTP POST requests at a configured path. Supports HMAC-SHA256 signature verification and rate limiting.

```typescript
export default defineTrigger({
  name: "deploy-webhook",
  type: "webhook",
  workload: "deploy-agent",
  tenant: { fromField: "repository.owner", prefix: "gh-" },
  config: {
    path: "/hooks/deploy",
    secret: "whsec_...",   // Optional: HMAC-SHA256 signature verification
    rateLimit: {           // Optional: per-endpoint rate limiting
      max: 60,             // Maximum requests per window (default: 60)
      windowMs: 60_000,    // Window size in milliseconds (default: 60000)
    },
  },
});
```

When `secret` is set, requests must include an `X-Signature-256` header containing a valid HMAC-SHA256 signature of the request body.

### Slack

Listens for Slack Events API callbacks. Verifies request signatures using the app's signing secret.

```typescript
export default defineTrigger({
  name: "slack-support",
  type: "slack",
  workload: "support-agent",
  tenant: { fromField: "user_id", prefix: "slack-" },
  config: {
    signingSecret: "...",                        // Slack app signing secret
    botToken: "xoxb-...",                        // Bot token for sending responses
    eventTypes: ["message", "app_mention"],       // Events to handle
  },
});
```

### Telegram

Uses long-polling to receive Telegram updates from the Bot API. No webhook URL is needed.

```typescript
export default defineTrigger({
  name: "tg-agent",
  type: "telegram-poll",
  workload: "chat-agent",
  tenant: { fromField: "usernameOrId", prefix: "tg-" },
  config: {
    botToken: "123456:ABC-DEF...",    // Token from @BotFather
    updateTypes: ["message"],         // Default: ["message"]
    pollTimeoutSeconds: 30,           // Long-poll timeout (default: 30)
  },
});
```

::: tip
Telegram long-polling is convenient for development because it does not require a publicly accessible URL. For production, ensure the trigger gateway process stays running to maintain the polling loop.
:::

### Cron

Fires on a cron schedule with an optional static payload. Uses standard 5-field cron expressions.

```typescript
export default defineTrigger({
  name: "nightly-report",
  type: "cron",
  workload: "report-agent",
  tenant: { static: "system" },
  config: {
    schedule: "0 2 * * *",                 // 2 AM daily
    payload: { type: "daily-report" },     // Optional static payload
  },
});
```

## Tenant Resolution

Every trigger defines how to extract the tenant ID from each incoming event:

### Static Mapping

Always routes to the same tenant. Useful for cron jobs and system-level triggers.

```typescript
tenant: { static: "reporting-bot" }
```

### Field Extraction

Extracts the tenant ID from a dot-path in the event context, with an optional prefix:

```typescript
tenant: { fromField: "user_id", prefix: "slack-" }
// If event context has user_id = "U12345", tenant becomes "slack-U12345"

tenant: { fromField: "body.tenantId" }
// Dot paths work for nested fields in webhook payloads
```

The field path is resolved against the adapter's event context object, which varies by adapter type.

## Guards

Guards run before a claim is made, implementing access control. Guards execute sequentially and short-circuit on the first denial.

```typescript
guards: [
  {
    guard: "@boilerhouse/guard-allowlist",
    guardOptions: {
      tenantIds: ["alice", "bob", "tg-admin"],
      denyMessage: "You are not authorized to use this service.",
    },
  },
  {
    guard: "@boilerhouse/guard-api",
    guardOptions: {
      url: "https://auth.example.com/check",
    },
  },
]
```

A guard returns `{ ok: true }` to allow the claim, or `{ ok: false, message: "..." }` to deny it. When a guard denies a claim, the message is sent back to the event source (e.g., a Telegram reply or Slack message).

### Allowlist Guard

The built-in `@boilerhouse/guard-allowlist` accepts a list of tenant IDs and denies any tenant not in the list:

```typescript
{
  guard: "@boilerhouse/guard-allowlist",
  guardOptions: {
    tenantIds: (process.env.BOILERHOUSE_ALLOWLIST_TENANT_IDS ?? "").split(",").filter(Boolean),
    denyMessage: "Not authorized.",
  },
}
```

## Drivers

Drivers handle communication between the trigger system and the container. After an instance is claimed, the driver sends the event payload and collects the response.

```typescript
interface Driver {
  transport?: "http" | "websocket";
  handshake?(endpoint: DriverEndpoint, config: DriverConfig): Promise<void>;
  send(endpoint: DriverEndpoint, payload: TriggerPayload, context: SendContext, config: DriverConfig): Promise<unknown>;
}
```

The default driver sends the payload over WebSocket. Specialized drivers translate between trigger events and application-specific protocols.

### Built-in Drivers

| Driver | Description |
|---|---|
| `@boilerhouse/driver-claude-code` | Communicates with Claude Code containers |
| `@boilerhouse/driver-openclaw` | Communicates with OpenClaw containers |
| `@boilerhouse/driver-pi` | Communicates with Pi containers |

Specify a driver in the trigger definition:

```typescript
export default defineTrigger({
  name: "tg-claude-code",
  type: "telegram-poll",
  workload: "claude-code",
  driver: "@boilerhouse/driver-claude-code",
  driverOptions: {},
  // ...
});
```

When no driver is specified, the built-in default driver is used.

## Trigger Payload

All adapters normalize events into a consistent shape before passing them to the driver:

```typescript
interface TriggerPayload {
  text: string;    // Message text (empty string for non-text events)
  source: "webhook" | "slack" | "telegram" | "cron";
  raw: unknown;    // Original adapter-specific event data
}
```

Drivers can inspect `raw` for adapter-specific fields (e.g., Slack thread timestamps, Telegram chat metadata, webhook headers).

## Trigger Queue

When multiple events arrive for the same tenant concurrently, they are queued and processed sequentially. This prevents race conditions from multiple simultaneous claims for the same tenant and ensures messages are delivered in order.

## Complete Example

Here is a full trigger definition for a Telegram-connected Claude Code agent with an allowlist guard:

```typescript
import { defineTrigger } from "@boilerhouse/triggers";

export default defineTrigger({
  name: "tg-claude-code",
  type: "telegram-poll",
  workload: "claude-code",
  tenant: { fromField: "usernameOrId", prefix: "tg-" },
  config: {
    botToken: process.env.TELEGRAM_BOT_TOKEN_CC ?? "",
    updateTypes: ["message"],
    pollTimeoutSeconds: 30,
  },
  driver: "@boilerhouse/driver-claude-code",
  driverOptions: {},
  guards: [
    {
      guard: "@boilerhouse/guard-allowlist",
      guardOptions: {
        tenantIds: (process.env.BOILERHOUSE_ALLOWLIST_TENANT_IDS ?? "")
          .split(",")
          .filter(Boolean),
        denyMessage: "You are not authorised to use this service.",
      },
    },
  ],
});
```

## Related Pages

- [Workloads](./workloads.md) -- defining the workload that triggers claim
- [Networking](./networking.md) -- credential injection for AI agent API calls
- [Tenants](./tenants.md) -- tenant lifecycle and identity
