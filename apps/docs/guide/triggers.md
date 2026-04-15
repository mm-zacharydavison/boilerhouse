# Triggers

Triggers connect external events to Boilerhouse instances. When a Telegram message arrives, a Slack event fires, a webhook is called, or a cron schedule ticks, a trigger claims an instance for the appropriate tenant and forwards the event.

## How Triggers Work

```
External Event ──► Adapter (parse event) ──► Guard Chain (authorize)
                                                    │
                                              ──► Dispatcher ──► Claim instance
                                                    │
                                              ──► Driver (forward to container)
                                                    │
                                              ──► Response back to source
```

1. **Adapter** receives the external event and normalizes it into a `TriggerPayload`
2. **Tenant resolution** extracts the tenant ID from the event (e.g., Telegram user ID)
3. **Guard chain** checks authorization (allowlist, API-based, etc.)
4. **Dispatcher** claims an instance for the tenant
5. **Driver** forwards the payload to the container via HTTP or WebSocket
6. **Response** is sent back to the original source

## Defining a Trigger

Triggers are defined using `defineTrigger()`:

```typescript
import { defineTrigger } from "@boilerhouse/triggers";

export default defineTrigger({
  name: "my-webhook",
  type: "webhook",
  workload: "my-agent",
  tenant: { fromField: "userId" },
  config: {
    path: "/hooks/my-agent",
    secret: "my-hmac-secret",
  },
});
```

Or via the API:

```bash
curl -X POST http://localhost:3000/api/v1/triggers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-webhook",
    "type": "webhook",
    "workload": "my-agent",
    "tenant": {"fromField": "userId"},
    "config": {"path": "/hooks/my-agent"}
  }'
```

## Built-in Adapters

### Webhook

Generic HTTP webhook handler with optional HMAC-SHA256 signature verification.

```typescript
defineTrigger({
  name: "deploy-hook",
  type: "webhook",
  workload: "my-agent",
  tenant: { fromField: "repository.owner" },
  config: {
    path: "/hooks/deploy",
    secret: "whsec_abc123",     // optional HMAC secret
    rateLimit: {                 // optional rate limiting
      max: 10,
      windowMs: 60000,
    },
  },
});
```

The webhook validates the `X-Hub-Signature-256` header if a `secret` is configured.

### Slack

Receives Slack Events API callbacks.

```typescript
defineTrigger({
  name: "slack-agent",
  type: "slack",
  workload: "my-agent",
  tenant: { fromField: "userId", prefix: "slack-" },
  config: {
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    botToken: process.env.SLACK_BOT_TOKEN!,
    eventTypes: ["message"],
  },
});
```

The adapter:
- Verifies Slack request signatures (HMAC-SHA256)
- Handles URL verification challenges
- Resolves tenant from event context (user, channel, or team)
- Posts responses back to Slack channels

### Telegram (Polling)

Long-polls the Telegram Bot API. No inbound endpoint required — secure for environments without public internet exposure.

```typescript
defineTrigger({
  name: "tg-agent",
  type: "telegram-poll",
  workload: "my-agent",
  tenant: { fromField: "usernameOrId", prefix: "tg-" },
  config: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    updateTypes: ["message"],
    pollTimeoutSeconds: 30,
  },
});
```

The adapter:
- Long-polls `getUpdates` with offset tracking
- Resolves tenant from chat ID, user ID, or username
- Sends responses via `sendMessage`
- Backs off on errors (5 second delay)
- Cleans up webhooks before starting polling

### Cron

Fires on a schedule using cron syntax.

```typescript
defineTrigger({
  name: "daily-cleanup",
  type: "cron",
  workload: "my-agent",
  tenant: { static: "system" },
  config: {
    schedule: "0 2 * * *",    // 2 AM daily
    payload: { task: "cleanup" },
  },
});
```

Cron triggers use `static` tenant mapping since there's no external event to extract a tenant from.

## Tenant Resolution

Triggers need to determine which tenant an event belongs to. Two strategies:

### Static

Always maps to the same tenant:

```typescript
tenant: { static: "system-user" }
```

### From Field

Extracts the tenant ID from the event payload:

```typescript
tenant: { fromField: "userId" }
tenant: { fromField: "usernameOrId", prefix: "tg-" }
```

The `fromField` value maps to adapter-specific parsed fields:

| Adapter | Available Fields |
|---------|-----------------|
| Webhook | Any field path from the JSON body |
| Slack | `userId`, `channelId`, `teamId` |
| Telegram | `chatId`, `userId`, `usernameOrId` |
| Cron | N/A (use `static`) |

The optional `prefix` prepends a string to the extracted value (e.g., `userId: "12345"` + `prefix: "tg-"` = tenant ID `tg-12345`).

## Guards

Guards authorize tenants before claiming an instance. They run as a chain — if any guard denies, the trigger is rejected.

### Allowlist Guard

Static list of allowed tenant IDs:

```typescript
defineTrigger({
  name: "tg-agent",
  type: "telegram-poll",
  workload: "my-agent",
  tenant: { fromField: "usernameOrId", prefix: "tg-" },
  config: { ... },
  guards: [{
    guard: "@boilerhouse/guard-allowlist",
    guardOptions: {
      tenantIds: ["tg-alice", "tg-bob"],
      denyMessage: "You are not authorized to use this agent.",
    },
  }],
});
```

Matching is case-insensitive.

### API Guard

Delegates authorization to an external HTTP endpoint:

```typescript
guards: [{
  guard: "@boilerhouse/guard-api",
  guardOptions: {
    url: "https://my-api.example.com/auth/check",
    headers: { "Authorization": "Bearer my-token" },
    denyMessage: "Access denied.",
  },
}]
```

The guard POSTs `{ tenantId, source }` to the URL and expects `{ ok: true }` or `{ ok: false, message }`. It fails closed — network errors, timeouts (3s), and malformed responses all result in denial.

## Drivers

Drivers handle the protocol between Boilerhouse and the container. They format the trigger payload for the specific agent running inside.

```typescript
defineTrigger({
  name: "tg-claude-code",
  type: "telegram-poll",
  workload: "claude-code",
  tenant: { fromField: "usernameOrId", prefix: "tg-" },
  config: { ... },
  driver: "@boilerhouse/driver-claude-code",
});
```

### Built-in Drivers

| Driver | Protocol | Description |
|--------|----------|-------------|
| `@boilerhouse/driver-claude-code` | WebSocket | Claude Code bridge protocol |
| `@boilerhouse/driver-openclaw` | WebSocket | OpenClaw control protocol |
| `@boilerhouse/driver-pi` | WebSocket | Pi agent protocol |

### Without a Driver

If no driver is specified, the dispatcher sends the payload as a plain HTTP POST to the container's first exposed port. This works for any container that accepts JSON webhooks.

## Managing Triggers via API

```bash
# List triggers
curl http://localhost:3000/api/v1/triggers

# Get trigger
curl http://localhost:3000/api/v1/triggers/:id

# Create trigger
curl -X POST http://localhost:3000/api/v1/triggers -d '{...}'

# Update trigger
curl -X PUT http://localhost:3000/api/v1/triggers/:id -d '{...}'

# Enable/disable
curl -X POST http://localhost:3000/api/v1/triggers/:id/enable
curl -X POST http://localhost:3000/api/v1/triggers/:id/disable

# Delete
curl -X DELETE http://localhost:3000/api/v1/triggers/:id

# Test with a sample payload
curl -X POST http://localhost:3000/api/v1/triggers/:id/test \
  -d '{"tenantId": "test-user", "payload": {"message": "hello"}}'
```

## Full Schema Reference

See [Trigger Schema Reference](../reference/trigger-schema) for the complete typed schema.
