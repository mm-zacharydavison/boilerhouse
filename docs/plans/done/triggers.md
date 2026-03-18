# Triggers Plan

## Context

Boilerhouse manages container lifecycle for tenants via its API. To function as an agent
platform, we need a way for **external events** (Slack messages, webhooks, cron schedules)
to automatically spin up agent containers and route messages to them.

The triggers layer is a thin, stateless adapter. It receives external events, translates
them into boilerhouse API calls (tenant claim), and forwards the event payload to the
resulting container endpoint. All state lives in boilerhouse — the trigger adapters hold
nothing.

This is independent of the Kubernetes runtime work and can be built in parallel.

## Architecture

```
External Event Sources           Trigger Adapters              Boilerhouse
┌──────────────┐
│  Slack       │──event──┐
└──────────────┘         │       ┌────────────────────┐
┌──────────────┐         │       │  apps/triggers     │
│  Telegram    │──event──┤       │                    │    POST /tenants/:id/claim
└──────────────┘         ├──────>│  ┌──────────────┐  │──────────────────────────>┌───────────┐
┌──────────────┐         │       │  │  dispatcher  │  │<─────────────────────────│ API Server │
│  Webhook     │──event──┤       │  └──────┬───────┘  │    { endpoint }          └───────────┘
└──────────────┘         │       │         │          │
┌──────────────┐         │       │         │ forward  │    POST payload
│  Cron        │──tick───┘       │         │ payload  │──────────────────────────>┌───────────┐
└──────────────┘                 │         ▼          │<─────────────────────────│  Agent    │
                                 │    agent endpoint  │    response              │ Container │
                                 └────────────────────┘                          └───────────┘
```

## Package Structure

```
apps/triggers/
  package.json          @boilerhouse/triggers
  tsconfig.json
  src/
    index.ts            entry point — loads config, starts Bun.serve()
    config.ts           TriggerConfig, TriggerDefinition, adapter configs
    dispatcher.ts       core loop: claim → forward → respond
    dispatcher.test.ts
    adapters/
      webhook.ts        HTTP POST receiver + HMAC validation
      webhook.test.ts
      slack.ts           Slack Events API handler
      slack.test.ts
      telegram.ts        Telegram Bot API webhook handler
      telegram.test.ts
      cron.ts            interval-based cron scheduler
      cron.test.ts
    client.ts           typed fetch wrapper for boilerhouse API
    client.test.ts
```

Dependencies: `@boilerhouse/core: "workspace:*"` (for branded ID types and workload types only).

## Configuration

Loaded from a JSON config file (path via `TRIGGERS_CONFIG` env var) or composed
programmatically in tests:

```typescript
interface TriggerConfig {
  /** Base URL of the boilerhouse API.
   * @example "http://localhost:3000"
   */
  boilerhouseApiUrl: string;

  /** Port for the trigger HTTP server.
   * @default 3001
   */
  port?: number;

  /** Trigger definitions. */
  triggers: TriggerDefinition[];
}

/** How to resolve tenant ID for a trigger event.
 * - `static`: always use the same tenant ID (typical for cron).
 * - `fromField`: extract from the event payload at runtime
 *   (e.g. Slack user, Telegram chat ID). Optional `prefix`
 *   is prepended to the extracted value.
 */
type TenantMapping =
  | { static: string }
  | { fromField: string; prefix?: string };

interface TriggerDefinition {
  /** Unique name for this trigger.
   * @example "slack-support-agent"
   */
  name: string;

  /** Adapter type. */
  type: "webhook" | "slack" | "telegram" | "cron";

  /** How to resolve the tenant ID from the incoming event.
   * Most adapters use `fromField` to derive tenant dynamically;
   * cron typically uses `static`.
   */
  tenant: TenantMapping;

  /** Workload name to claim. Must exist in boilerhouse. */
  workload: string;

  /** Adapter-specific configuration. */
  config: WebhookConfig | SlackConfig | TelegramConfig | CronConfig;
}
```

### Adapter Configs

```typescript
interface WebhookConfig {
  /** URL path to listen on.
   * @example "/hooks/deploy-agent"
   */
  path: string;

  /** HMAC secret for signature verification (SHA-256).
   * If set, requests must include X-Signature-256 header.
   */
  secret?: string;
}

interface SlackConfig {
  /** Slack app signing secret for request verification. */
  signingSecret: string;

  /** Slack event types to handle.
   * @example ["message", "app_mention"]
   */
  eventTypes: string[];

  /** Slack bot token for sending responses.
   * @example "xoxb-..."
   */
  botToken: string;
}

interface TelegramConfig {
  /** Telegram bot token from @BotFather.
   * @example "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
   */
  botToken: string;

  /** Webhook secret token for verifying incoming updates.
   * Telegram sends this in the X-Telegram-Bot-Api-Secret-Token header.
   */
  secretToken?: string;

  /** Message types to handle.
   * @default ["message"]
   * @example ["message", "callback_query"]
   */
  updateTypes?: string[];
}

interface CronConfig {
  /** Cron expression (5-field standard).
   * @example "0 * * * *"  (every hour)
   * @example "*/5 * * * *"  (every 5 minutes)
   */
  schedule: string;

  /** Static payload to forward when the cron fires. */
  payload?: Record<string, unknown>;
}
```

## Dispatcher

The dispatcher is the core — all adapters funnel through it:

```typescript
interface TriggerEvent {
  /** Which trigger definition fired. */
  triggerName: string;
  /** Resolved tenant ID (adapter resolves via TenantMapping before dispatching). */
  tenantId: string;
  /** Workload to run. */
  workload: string;
  /** Payload to forward to the agent container. */
  payload: unknown;
  /** Optional: where to send the response (adapter handles this). */
  respond?: (response: unknown) => Promise<void>;
}
```

### Dispatch flow

```
1. Adapter parses external event
2. Adapter resolves tenant ID via resolveTenantId(trigger.tenant, eventContext)
3. dispatcher.dispatch(event):
   a. POST ${boilerhouseApiUrl}/api/v1/tenants/${tenantId}/claim
      body: { workload }
      → { endpoint: { host, ports }, instanceId, source }
   b. POST http://${endpoint.host}:${endpoint.ports[0]}/
      body: event.payload
      → agentResponse
   c. Return agentResponse to adapter
4. Adapter routes response back to source (Slack reply, webhook callback, etc.)
```

### Tenant Resolution (`resolve-tenant.ts`)

Each adapter builds a context object from the incoming event and calls
`resolveTenantId(trigger.tenant, context)`:

- **Static**: returns the configured string directly.
- **Dynamic**: looks up `fromField` in the context (supports dot-path like
  `message.from.id`), coerces to string, and prepends `prefix` if set.
- Throws `TenantResolutionError` if the field is missing.

Default tenant mappings per adapter type:
| Adapter   | Default `fromField` | Default `prefix` |
|-----------|---------------------|-------------------|
| webhook   | `tenantId`          | (none)            |
| slack     | `user`              | `slack-`          |
| telegram  | `chatId`            | `tg-`             |
| cron      | (static only)       | (none)            |

### Error handling

- **Boilerhouse API unreachable**: retry once, then return 502 to caller
- **Claim fails (503 no golden)**: return error to caller with context
- **Agent endpoint unreachable**: return 504 to caller
- **Agent returns error**: pass through to caller

### Boilerhouse API Client

`client.ts` — typed fetch wrapper:

```typescript
class BoilerhouseClient {
  constructor(private baseUrl: string) {}

  async claimTenant(tenantId: string, workload: string): Promise<ClaimResult>
  async releaseTenant(tenantId: string): Promise<void>
  async getInstanceStatus(instanceId: string): Promise<InstanceStatus>
}
```

## Adapters

### Webhook Adapter

Registers routes on the Bun HTTP server. Each webhook trigger definition gets its own
path.

```typescript
// Route: POST /hooks/deploy-agent
// Headers: X-Signature-256 (optional, HMAC-SHA256 of body)
// Body: arbitrary JSON (forwarded as-is to agent)

function createWebhookRoutes(
  triggers: Array<TriggerDefinition & { config: WebhookConfig }>,
  dispatcher: Dispatcher,
): Record<string, RouteHandler>
```

**HMAC validation**: If `secret` is configured, compute
`sha256=HMAC(secret, rawBody)` and compare with `X-Signature-256` header.
Reject with 401 if mismatch.

### Slack Adapter

Handles the Slack Events API protocol:

1. **URL verification**: When Slack sends `{ type: "url_verification", challenge }`,
   respond with `{ challenge }`. This happens during app setup.

2. **Event callbacks**: When `{ type: "event_callback", event }`:
   - Verify request signature using the signing secret
   - Check if `event.type` matches any configured `eventTypes`
   - Extract message text and channel from the event
   - Dispatch to boilerhouse with the Slack event as payload
   - Post agent response back to Slack channel via `chat.postMessage`

3. **Signature verification**: Slack sends `X-Slack-Signature` and
   `X-Slack-Request-Timestamp`. Compute
   `v0=HMAC-SHA256(signingSecret, "v0:{timestamp}:{body}")` and compare.

**Route**: `POST /slack/events` (single endpoint for all Slack triggers)

### Telegram Adapter

Handles the Telegram Bot API webhook protocol:

1. **Webhook setup**: On startup, call `setWebhook` to register the trigger URL
   with Telegram. Include `secret_token` if configured.

2. **Incoming updates**: When Telegram sends `{ update_id, message, ... }`:
   - Verify `X-Telegram-Bot-Api-Secret-Token` header matches `secretToken`
   - Check if the update type matches any configured `updateTypes`
   - Extract message text and chat ID from the update
   - Dispatch to boilerhouse with the Telegram update as payload
   - Post agent response back to the chat via `sendMessage`

3. **Secret verification**: Telegram sends the secret token in the
   `X-Telegram-Bot-Api-Secret-Token` header. Compare with configured
   `secretToken` and reject with 401 if mismatch.

**Route**: `POST /telegram/:triggerName` (one endpoint per Telegram trigger)

```typescript
function createTelegramRoutes(
  triggers: Array<TriggerDefinition & { config: TelegramConfig }>,
  dispatcher: Dispatcher,
): Record<string, RouteHandler>
```

**Webhook registration** (called on startup):

```typescript
async function registerTelegramWebhooks(
  triggers: Array<TriggerDefinition & { config: TelegramConfig }>,
  baseUrl: string,
): Promise<void> {
  for (const trigger of triggers) {
    await fetch(
      `https://api.telegram.org/bot${trigger.config.botToken}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${baseUrl}/telegram/${trigger.name}`,
          secret_token: trigger.config.secretToken,
          allowed_updates: trigger.config.updateTypes ?? ["message"],
        }),
      },
    );
  }
}
```

**Response routing**: After dispatching, send the agent response back via:

```typescript
await fetch(
  `https://api.telegram.org/bot${botToken}/sendMessage`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: update.message.chat.id,
      text: agentResponse,
    }),
  },
);
```

### Cron Adapter

No external HTTP — runs internally on a timer.

```typescript
class CronAdapter {
  private timers: Timer[] = [];

  start(
    triggers: Array<TriggerDefinition & { config: CronConfig }>,
    dispatcher: Dispatcher,
  ): void {
    for (const trigger of triggers) {
      const intervalMs = parseCronToIntervalMs(trigger.config.schedule);
      // For MVP: convert cron to interval. Full cron scheduling (next-run
      // calculation) can come later.
      const tenantId = resolveTenantId(trigger.tenant, {});
      const timer = setInterval(() => {
        dispatcher.dispatch({
          triggerName: trigger.name,
          tenantId,
          workload: trigger.workload,
          payload: trigger.config.payload ?? {},
        });
      }, intervalMs);
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
```

For MVP, support simple intervals (`*/5 * * * *` → every 5 min, `0 * * * *` → every
hour). Full cron next-run calculation can be added later.

## Entry Point

`src/index.ts`:

```typescript
const configPath = process.env.TRIGGERS_CONFIG ?? "./triggers.json";
const config = JSON.parse(await Bun.file(configPath).text()) as TriggerConfig;

const client = new BoilerhouseClient(config.boilerhouseApiUrl);
const dispatcher = new Dispatcher(client);

// Group triggers by type
const webhookTriggers = config.triggers.filter(t => t.type === "webhook");
const slackTriggers = config.triggers.filter(t => t.type === "slack");
const telegramTriggers = config.triggers.filter(t => t.type === "telegram");
const cronTriggers = config.triggers.filter(t => t.type === "cron");

// Start cron timers
const cronAdapter = new CronAdapter();
cronAdapter.start(cronTriggers, dispatcher);

// Register Telegram webhooks with Telegram API
const publicUrl = process.env.TRIGGERS_PUBLIC_URL;
if (telegramTriggers.length > 0 && publicUrl) {
  await registerTelegramWebhooks(telegramTriggers, publicUrl);
}

// Build HTTP routes
const webhookRoutes = createWebhookRoutes(webhookTriggers, dispatcher);
const slackRoutes = createSlackRoutes(slackTriggers, dispatcher);
const telegramRoutes = createTelegramRoutes(telegramTriggers, dispatcher);

Bun.serve({
  port: config.port ?? 3001,
  routes: {
    ...webhookRoutes,
    ...slackRoutes,
    ...telegramRoutes,
    "/healthz": () => new Response("ok"),
  },
});
```

## Testing

### Unit tests (no external services)

**`dispatcher.test.ts`**:
- Mock boilerhouse API with a local HTTP server
- Test happy path: claim succeeds → payload forwarded → response returned
- Test claim failure (503) → error propagated
- Test agent endpoint unreachable → 504
- Test retry on transient failure

**`client.test.ts`**:
- Mock HTTP server returning boilerhouse API responses
- Test each method: claimTenant, releaseTenant, getInstanceStatus
- Test error responses (4xx, 5xx)

**`webhook.test.ts`**:
- Test HMAC signature validation (valid, invalid, missing)
- Test route registration for multiple webhook triggers
- Test payload passthrough

**`slack.test.ts`**:
- Test URL verification challenge response
- Test request signature verification
- Test event type filtering (matching vs non-matching)
- Test response posting via mock Slack API

**`telegram.test.ts`**:
- Test secret token verification (valid, invalid, missing)
- Test update type filtering (matching vs non-matching)
- Test message extraction from different update types
- Test response posting via mock Telegram Bot API
- Test webhook registration calls setWebhook with correct params

**`cron.test.ts`**:
- Test cron expression parsing (common patterns)
- Test timer fires at correct intervals
- Test stop() clears all timers
- Use `Bun.sleep()` or fake timers for timing tests

### Integration test

Start a real boilerhouse API server (with FakeRuntime) + triggers app:

1. Load a workload via boilerhouse API
2. Start triggers with a webhook trigger config pointing at the test boilerhouse
3. `POST /hooks/test-agent` with a payload
4. Verify: boilerhouse received a claim, FakeRuntime created an instance
5. Verify: payload was forwarded to the (fake) agent endpoint

This can run in CI without any external services.

## API Endpoints (Trigger CRUD)

Triggers are currently file-based config. To support dashboard management, the API server
needs CRUD endpoints that read/write to a `triggers` table in the DB. The triggers app
then watches for config changes (polling or notification).

### DB Schema

New table in `packages/db/src/schema.ts`:

```typescript
export const triggers = sqliteTable("triggers", {
  id: text("id").$type<TriggerId>().primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type").notNull().$type<TriggerType>(),
  tenant: jsonObject<TenantMapping>("tenant").notNull(),
  workload: text("workload").notNull(),
  config: jsonObject<TriggerAdapterConfig>("config").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});
```

### Routes (`apps/api/src/routes/triggers.ts`)

| Method | Path                     | Description                    |
|--------|--------------------------|--------------------------------|
| GET    | `/api/v1/triggers`       | List all triggers              |
| GET    | `/api/v1/triggers/:id`   | Get single trigger             |
| POST   | `/api/v1/triggers`       | Create trigger                 |
| PUT    | `/api/v1/triggers/:id`   | Update trigger                 |
| DELETE | `/api/v1/triggers/:id`   | Delete trigger                 |
| POST   | `/api/v1/triggers/:id/enable`  | Enable trigger            |
| POST   | `/api/v1/triggers/:id/disable` | Disable trigger           |

### Config sync

The triggers app polls `GET /api/v1/triggers` on an interval (e.g. every 10s) and
reconciles its running adapters with the latest config. Changed triggers get their
adapters restarted; deleted triggers get stopped; new triggers get started.

## Dashboard UI

### Sidebar

Add a "Triggers" nav item to `NAV_ITEMS` in `apps/dashboard/src/app.tsx`:

```typescript
{ path: "/triggers", label: "Triggers", icon: Zap }
```

Position it after "Workloads" in the sidebar.

### Route

Add hash route `/triggers` → `TriggerList` page in `app.tsx`.

### Trigger List Page (`pages/TriggerList.tsx`)

Table-based list view, following the same patterns as `NodeList.tsx` / `ActivityLog.tsx`:

| Column   | Content                                                    |
|----------|------------------------------------------------------------|
| Name     | Trigger name (link to detail/edit?)                        |
| Type     | Adapter type badge: `webhook`, `slack`, `telegram`, `cron` |
| Workload | Target workload name                                      |
| Tenant   | Tenant mapping (static value or `prefix{field}`)           |
| Status   | Enabled/disabled indicator (● green / ○ gray)              |
| Created  | Relative time ("2h ago")                                   |
| Actions  | Toggle enable/disable, Delete button                       |

**Header bar**: Page title "Triggers" + "Create Trigger" `ActionButton` that opens
the create modal.

### Create Trigger Modal

Modal form (using existing `Modal` component from `components.tsx`) with fields:

**Common fields** (always shown):
- **Name** — text input, required
- **Type** — dropdown select: `webhook`, `slack`, `telegram`, `cron`
- **Workload** — dropdown select populated from `GET /api/v1/workloads`
- **Tenant** — fieldset with static/dynamic radio toggle:
  - **Static**: single text input for fixed tenant ID
  - **Dynamic (from event)**: `fromField` text input + optional `prefix` text input
  - Defaults change per adapter type (e.g. slack defaults to `fromField: "user"`, `prefix: "slack-"`)

**Adapter-specific fields** (shown/hidden based on selected type):

**Webhook**:
- Path — text input, placeholder `/hooks/my-agent`
- Secret — text input (optional), password-masked

**Slack**:
- Signing Secret — text input, required
- Bot Token — text input, required, password-masked
- Event Types — text input, comma-separated, placeholder `app_mention, message`

**Telegram**:
- Bot Token — text input, required, password-masked
- Secret Token — text input (optional), password-masked
- Update Types — text input, comma-separated, placeholder `message`, default `message`

**Cron**:
- Schedule — text input, placeholder `*/5 * * * *`
- Payload — JSON textarea (optional), syntax-highlighted

**Actions**: "Create" submit button + "Cancel" to dismiss.

On submit: `POST /api/v1/triggers` with the form data, then refetch the trigger list.

### Delete Confirmation

Clicking the delete action button shows a confirm dialog (browser `confirm()` as used
elsewhere in the dashboard). On confirm: `DELETE /api/v1/triggers/:id`, then refetch.

### API Client additions (`api.ts`)

```typescript
// Triggers
export async function fetchTriggers(): Promise<TriggerRow[]> {
  return get("/triggers");
}

export async function createTrigger(data: CreateTriggerInput): Promise<TriggerRow> {
  return postJson("/triggers", data);
}

export async function deleteTrigger(id: string): Promise<void> {
  await post(`/triggers/${id}/delete`);
}

export async function enableTrigger(id: string): Promise<void> {
  await post(`/triggers/${id}/enable`);
}

export async function disableTrigger(id: string): Promise<void> {
  await post(`/triggers/${id}/disable`);
}
```

### Files

```
apps/dashboard/src/
  pages/
    TriggerList.tsx        trigger management page
```

## Implementation Order

1. `config.ts` — types only
2. `client.ts` + `client.test.ts` — boilerhouse API client
3. `dispatcher.ts` + `dispatcher.test.ts` — core dispatch loop
4. `webhook.ts` + `webhook.test.ts` — first adapter
5. `index.ts` — entry point, webhook-only initially
6. Integration test with FakeRuntime
7. `slack.ts` + `slack.test.ts`
8. `telegram.ts` + `telegram.test.ts`
9. `cron.ts` + `cron.test.ts`
10. DB schema — `triggers` table + migration
11. API routes — `routes/triggers.ts` (CRUD endpoints)
12. Dashboard — `TriggerList.tsx` + API client additions + sidebar nav
13. Config sync — triggers app polls API for config changes

## Example Config

```json
{
  "boilerhouseApiUrl": "http://localhost:3000",
  "port": 3001,
  "triggers": [
    {
      "name": "support-agent",
      "type": "slack",
      "tenant": { "fromField": "user", "prefix": "slack-" },
      "workload": "support-agent",
      "config": {
        "signingSecret": "abc123...",
        "eventTypes": ["app_mention"],
        "botToken": "xoxb-..."
      }
    },
    {
      "name": "telegram-assistant",
      "type": "telegram",
      "tenant": { "fromField": "chatId", "prefix": "tg-" },
      "workload": "assistant-agent",
      "config": {
        "botToken": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        "secretToken": "my-webhook-secret",
        "updateTypes": ["message"]
      }
    },
    {
      "name": "deploy-hook",
      "type": "webhook",
      "tenant": { "fromField": "tenantId" },
      "workload": "deploy-agent",
      "config": {
        "path": "/hooks/deploy",
        "secret": "whsec_..."
      }
    },
    {
      "name": "daily-report",
      "type": "cron",
      "tenant": { "static": "reporting" },
      "workload": "report-agent",
      "config": {
        "schedule": "0 9 * * *",
        "payload": { "type": "daily-summary" }
      }
    }
  ]
}
```
