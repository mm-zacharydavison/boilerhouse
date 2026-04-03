# Wake-Up Tasks — Agent-Created Triggers

**Goal:** Allow agents (tenants) to create their own triggers from within a running
session — e.g. "remind me in 2 hours", "check deployment status every 5 minutes",
"run a daily summary at 9am". This is not a separate scheduling system; it uses the
existing `triggers` table with access control, rate limits, and a clear admin/user
distinction.

**Dependency:** [Container-Scoped API Keys](feat-container-scoped-api-keys.md) — agents
need an authenticated, scoped API key to call the Boilerhouse API. That plan provisions
ephemeral bearer tokens per-container with RBAC scopes. This plan requires the
`agent-triggers:read` and `agent-triggers:write` scopes to exist.

**Key design principles:**

1. **No new table.** Agent-created triggers are rows in the existing `triggers` table
   with `origin: "agent"`. The triggers CRUD API and CronAdapter already handle them.
2. **Constrained API.** Agents get a limited subset of trigger creation — only `cron` and
   `one-shot` types, with enforced minimum intervals, max count per tenant, and scoped
   to their own tenant + workload.
3. **Admin vs user triggers.** A new `origin` column on the triggers table distinguishes
   `"admin"` (created via YAML/dashboard) from `"agent"` (created by a running agent).
   The dashboard filters by default to show only admin triggers.
4. **Authenticated via container API key.** The agent uses `BOILERHOUSE_API_KEY` (injected
   at container creation) to call `POST /api/v1/agent-triggers`. The auth middleware
   resolves the key's scope and tenant — no separate auth mechanism needed.
5. **Delivered as a skill.** The agent accesses this via a Boilerhouse internal API skill
   — not direct DB access. The skill wraps `POST /api/v1/agent-triggers`.

---

## Architecture

```
Agent (inside container)
  → calls Boilerhouse API via BOILERHOUSE_API_URL env var
  → POST /api/v1/agent-triggers { schedule, payload, label }
  → API validates: tenant matches, rate limits, min interval
  → inserts trigger row with origin="agent", scoped to tenant
  → CronAdapter picks it up on next poll cycle
  → trigger fires → dispatches to the agent's workload
  → response sent back via stored replyContext
```

The agent doesn't need to know about trigger internals — it just says "wake me up at
this time with this context" and the system handles the rest.

---

## Schema Change: `origin` Column

### `packages/db/src/schema.ts`

Add to the `triggers` table definition (after `enabled`, before `lastInvokedAt`):

```typescript
/**
 * Who created this trigger.
 * - "admin": created via YAML file, dashboard, or admin API (default)
 * - "agent": created by a running agent via the agent-triggers API
 */
origin: text("origin").notNull().default("admin").$type<"admin" | "agent">(),

/** Tenant that created this trigger (set when origin="agent"). */
createdByTenant: text("created_by_tenant"),

/**
 * For one-shot triggers: ISO-8601 datetime when the trigger should fire.
 * Null for recurring cron triggers.
 * After firing, the trigger is automatically disabled (enabled=0).
 */
runAt: timestamp("run_at"),

/**
 * Reply context for delivering the wake-up result back to the originating chat.
 * Serialized ReplyContext — same shape as in the queue job data.
 */
replyContext: jsonObject<Record<string, unknown>>("reply_context"),
```

### Migration: `packages/db/drizzle/0016_trigger_origin.sql`

```sql
ALTER TABLE `triggers` ADD COLUMN `origin` text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE `triggers` ADD COLUMN `created_by_tenant` text;
--> statement-breakpoint
ALTER TABLE `triggers` ADD COLUMN `run_at` integer;
--> statement-breakpoint
ALTER TABLE `triggers` ADD COLUMN `reply_context` text;
--> statement-breakpoint
CREATE INDEX `triggers_origin_idx` ON `triggers` (`origin`);
--> statement-breakpoint
CREATE INDEX `triggers_created_by_tenant_idx` ON `triggers` (`created_by_tenant`);
--> statement-breakpoint
CREATE INDEX `triggers_run_at_idx` ON `triggers` (`run_at`);
```

Existing triggers get `origin = "admin"` via the DEFAULT — no data migration needed.

---

## Agent Trigger Constraints

Agents operate under strict limits to prevent abuse and noise:

```typescript
export interface AgentTriggerPolicy {
  /** Allowed trigger types agents can create. */
  allowedTypes: ("cron" | "one-shot")[];

  /** Minimum interval for cron triggers (in seconds). */
  minCronIntervalSeconds: number;  // default: 300 (5 minutes)

  /** Maximum active triggers per tenant. */
  maxTriggersPerTenant: number;    // default: 10

  /** Maximum duration into the future for one-shot triggers. */
  maxOneShotHorizonSeconds: number; // default: 86400 * 30 (30 days)

  /** Minimum delay for one-shot triggers (prevent "now" scheduling). */
  minOneShotDelaySeconds: number;  // default: 60 (1 minute)
}
```

**Defaults:**

| Constraint | Default | Rationale |
|-----------|---------|-----------|
| Min cron interval | 5 minutes | Prevent CPU/cost abuse |
| Max triggers per tenant | 10 | Keep dashboard and DB manageable |
| Max one-shot horizon | 30 days | Don't accumulate stale far-future triggers |
| Min one-shot delay | 1 minute | Prevent "fire immediately" bypassing normal dispatch |
| Allowed types | `cron`, `one-shot` | No webhook/slack/telegram — those are admin-only |

These defaults are configurable via env vars or a future admin settings API.

---

## New Trigger Type: `one-shot`

A one-shot trigger fires exactly once at `runAt`, then auto-disables itself. It's
implemented as a special case in the CronAdapter:

- **Storage:** `type: "cron"`, but with `runAt` set and `config.schedule` set to a
  synthetic cron expression that matches the `runAt` time (or the poller checks `runAt`
  directly).
- **Simpler approach:** The CronAdapter's poll loop checks for `runAt`-based triggers
  separately: `SELECT * FROM triggers WHERE run_at IS NOT NULL AND run_at <= now AND enabled = 1`.
  When found, it dispatches and sets `enabled = 0`.

This avoids adding a new adapter type — the existing CronAdapter handles both recurring
and one-shot triggers.

---

## Agent Triggers API

### New route: `apps/api/src/routes/agent-triggers.ts`

This is a **separate route** from the admin `/triggers` CRUD. It has tighter validation
and is scoped to the calling tenant.

#### Authentication

The agent identifies itself via the `X-Boilerhouse-Tenant` header (or a signed token).
The API verifies the tenant matches the agent's session. This header is injected by the
container proxy — the agent doesn't forge it.

#### `POST /api/v1/agent-triggers`

Create a scheduled trigger for the calling tenant.

**Body:**

```typescript
{
  /** "cron" for recurring, "one-shot" for fire-once. */
  type: "cron" | "one-shot";

  /** Cron expression (5-field). Required when type="cron". */
  schedule?: string;

  /** ISO-8601 datetime. Required when type="one-shot". */
  runAt?: string;

  /** Payload forwarded to the agent when the trigger fires. */
  payload?: Record<string, unknown>;

  /** Human-readable label (shown in dashboard if admin looks). */
  label: string;

  /**
   * Where to send the result. Optional — if omitted, the trigger fires
   * into the agent's workload but the response is not routed anywhere.
   * Typically set to the current chat context so the wake-up reply
   * lands in the same conversation.
   */
  replyContext?: {
    adapter: "telegram" | "slack" | "webhook" | "cron";
    chatId?: number;
    channelId?: string;
    apiBaseUrl?: string;
    botToken?: string;
  };
}
```

**Validation:**

1. `type` must be `"cron"` or `"one-shot"` (reject webhook, telegram-poll, etc.).
2. If `cron`: validate expression via `croner`, compute next run, reject if interval
   < `minCronIntervalSeconds`.
3. If `one-shot`: validate `runAt` is in the future, within horizon, past min delay.
4. Count existing agent triggers for this tenant — reject if >= `maxTriggersPerTenant`.
5. `label` is required (agents must explain what the trigger is for).

**On success:** Insert into `triggers` with:
- `origin: "agent"`
- `createdByTenant: <tenant-id>`
- `name: "agent-{tenantId}-{shortUUID}"` (auto-generated, unique)
- `workload: <the agent's own workload>` (resolved from tenant's current claim)
- `tenant: { static: <tenantId> }` (scoped to self)
- `config: { schedule, payload }` or `{ payload }` + `runAt`
- `replyContext: <if provided>`
- `enabled: 1`

Returns 201 with the trigger row.

#### `GET /api/v1/agent-triggers`

List the calling tenant's own agent-created triggers.

Returns only triggers where `origin = "agent"` AND `createdByTenant = <tenantId>`.

#### `DELETE /api/v1/agent-triggers/:id`

Cancel/delete a trigger. Only allowed if `origin = "agent"` AND
`createdByTenant = <tenantId>`. Returns 403 if the trigger belongs to another
tenant or is an admin trigger.

---

## Cron Interval Validation

To enforce `minCronIntervalSeconds`, compute the gap between consecutive firings:

```typescript
import { Cron } from "croner";

function cronIntervalSeconds(expression: string): number | null {
  const job = new Cron(expression);
  const first = job.nextRun();
  if (!first) return null;
  const second = job.nextRun(first);
  if (!second) return null;
  return (second.getTime() - first.getTime()) / 1000;
}
```

If `cronIntervalSeconds(schedule) < policy.minCronIntervalSeconds`, reject with 400:
`"Cron interval must be at least 5 minutes"`.

---

## One-Shot Dispatch in CronAdapter

### Modified: `packages/triggers/src/adapters/cron.ts`

Add a poll loop (or extend the existing one) that checks for due one-shot triggers:

```typescript
// Every 10 seconds, check for due one-shot triggers
const oneShotPoller = setInterval(async () => {
  const now = new Date();
  const dueTriggers = db
    .select()
    .from(triggers)
    .where(
      and(
        isNotNull(triggers.runAt),
        lte(triggers.runAt, now),
        eq(triggers.enabled, 1),
      ),
    )
    .all();

  for (const trigger of dueTriggers) {
    // Disable immediately to prevent double-fire
    db.update(triggers)
      .set({ enabled: 0, updatedAt: new Date(), lastInvokedAt: new Date() })
      .where(eq(triggers.id, trigger.id))
      .run();

    // Dispatch
    await dispatcher.dispatch({
      triggerName: trigger.name,
      tenantId: resolveTenantFromTrigger(trigger),
      workload: trigger.workload,
      payload: {
        text: "",
        source: "cron" as const,
        raw: trigger.config?.payload ?? {},
      },
      replyContext: trigger.replyContext as ReplyContext | undefined,
    });
  }
}, 10_000);
```

This is the simplest approach — a 10s poll interval means one-shot triggers fire
within 10s of their `runAt` time. Good enough for "remind me in 2 hours" use cases.

---

## Dashboard: Admin vs Agent Triggers

### Modified: `apps/dashboard/src/pages/TriggerList.tsx`

Add a filter toggle: **Admin triggers** / **Agent triggers** / **All**.

Default view shows admin triggers only. Agent triggers are accessible via the toggle
but don't clutter the main view.

Agent triggers display:
- The `label` (human-readable, set by the agent)
- The `createdByTenant` (which tenant/agent created it)
- The `runAt` or `schedule`
- An "Agent-created" badge

Admin triggers display as they do today — no changes.

### Modified: `GET /api/v1/triggers`

Add optional query param `?origin=admin|agent|all` (default: `all` for API,
dashboard defaults to `admin`).

---

## Agent Skill: How the Agent Accesses This

The agent gets a skill (same pattern as the GitHub Issues skill) that wraps the
agent-triggers API.

### Option 1: Claude Code skill file (fastest)

A markdown skill file that teaches the agent the `curl` commands:

```markdown
# Schedule Wake-Up

You can schedule future wake-ups using the Boilerhouse agent-triggers API.

## Create a one-shot reminder

POST /api/v1/agent-triggers
{
  "type": "one-shot",
  "runAt": "2026-04-03T16:00:00Z",
  "label": "Check deployment status",
  "payload": { "task": "check deployment of PR #42" },
  "replyContext": { ... current chat context ... }
}

## Create a recurring check

POST /api/v1/agent-triggers
{
  "type": "cron",
  "schedule": "0 9 * * *",
  "label": "Daily standup summary",
  "payload": { "task": "summarize yesterday's activity" }
}

## List my triggers

GET /api/v1/agent-triggers

## Cancel a trigger

DELETE /api/v1/agent-triggers/{id}
```

### Option 2: MCP tool (follow-up)

A structured MCP tool with proper parameter schemas. Better for non-Claude-Code drivers
like Pi where the agent needs a formal tool definition.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/db/src/schema.ts` | Modify | Add `origin`, `createdByTenant`, `runAt`, `replyContext` to triggers |
| `packages/db/drizzle/0016_trigger_origin.sql` | Create | Migration for new columns + indexes |
| `packages/db/drizzle/meta/_journal.json` | Modify | Add migration entry |
| `apps/api/src/routes/agent-triggers.ts` | Create | Constrained agent-facing trigger CRUD |
| `apps/api/src/routes/agent-triggers.test.ts` | Create | Tests for validation, limits, scoping |
| `apps/api/src/app.ts` | Modify | Mount agent-triggers routes |
| `packages/triggers/src/adapters/cron.ts` | Modify | Add one-shot poller for `runAt`-based triggers |
| `packages/triggers/src/config.ts` | Modify | Add `AgentTriggerPolicy` type |
| `apps/api/src/routes/triggers.ts` | Modify | Add `?origin=` filter to GET /triggers |
| `apps/dashboard/src/pages/TriggerList.tsx` | Modify | Add origin filter toggle, agent trigger badge |

---

## Sequencing

1. Schema change: add columns + migration. No behaviour change.
2. `AgentTriggerPolicy` type in config.ts.
3. `agent-triggers.ts` route + tests. Testable in isolation with `createTestDatabase()`.
4. One-shot poller in `cron.ts`.
5. Mount route in `app.ts`.
6. Dashboard filter toggle.
7. Agent skill file.

Items 2-3 can be done in parallel with item 4.

---

## Security

### Authentication

Agents authenticate via `BOILERHOUSE_API_KEY` — a container-scoped bearer token
provisioned at claim time (see [Container-Scoped API Keys](feat-container-scoped-api-keys.md)).
The auth middleware resolves the key to an `AuthContext` containing `tenantId`, `workload`,
`instanceId`, and `scopes`. The agent-triggers route checks:

```typescript
requireScope(store.authContext, "agent-triggers:write")
```

No separate auth mechanism is needed. When the container is destroyed, the key is
revoked and all API access stops immediately.

### Tenant isolation

Enforced by the auth middleware + route-level checks. The container API key is bound to
a specific `tenantId` — the route verifies `authContext.tenantId` matches the request:

Agents can only:
- Create triggers scoped to their own tenant (`tenant: { static: tenantId }`).
- Target their own workload (resolved from `authContext.workload`).
- List/delete their own agent triggers.

They cannot:
- Create triggers for other tenants.
- Create triggers that target other workloads.
- Modify or delete admin triggers.
- Create webhook or platform-auth triggers (no Telegram/Slack/etc — those require
  bot tokens and are admin-only).

### Rate limiting

The agent-triggers endpoint inherits the API's global rate limit. Additionally:
- `maxTriggersPerTenant` hard cap prevents trigger accumulation.
- `minCronIntervalSeconds` prevents resource abuse from fast-polling triggers.
- One-shot triggers auto-disable after firing — they don't accumulate.

### Reply context and bot tokens

If the agent passes a `replyContext` with a `botToken`, that token is stored in the
trigger row. This is necessary for the wake-up response to reach the originating chat.
The bot token should ideally come from the trigger config (same way `sendReply` resolves
it today), not from the agent. The agent-triggers API should look up the originating
trigger's bot token and inject it automatically based on the `authContext`, rather than
trusting the agent to provide it.

---

## Example: "Remind Me in 2 Hours"

```
User (in Telegram): "remind me to check the deploy in 2 hours"

Agent thinks: I need to schedule a one-shot trigger.

Agent calls:
POST /api/v1/agent-triggers
{
  "type": "one-shot",
  "runAt": "2026-04-03T18:30:00Z",
  "label": "Reminder: check the deploy",
  "payload": {
    "task": "The user asked to be reminded to check the deploy. Tell them it's time."
  },
  "replyContext": {
    "adapter": "telegram",
    "chatId": 123456789
  }
}

Agent replies: "Got it, I'll remind you at 6:30 PM."

--- 2 hours later ---

CronAdapter one-shot poller finds the due trigger.
Dispatches to the agent's workload with the stored payload.
Agent sees payload.task: "The user asked to be reminded..."
Agent responds: "Hey! This is your reminder to check the deploy."
sendReply routes the response to Telegram chatId 123456789.
Trigger is auto-disabled (enabled=0).
```

---

## Open Questions

- **Cleanup of fired one-shot triggers:** After firing, one-shot triggers sit in the DB
  with `enabled=0`. Add a daily cleanup job that deletes agent one-shot triggers older
  than 7 days? Or let them accumulate as history? Leaning toward cleanup.
- **Editing triggers:** Should agents be able to modify existing triggers (e.g. change
  the schedule)? Start with create/delete only. If editing is needed, add
  `PATCH /api/v1/agent-triggers/:id` with the same validation.
- **Trigger quota per workload vs per tenant:** Current design limits per tenant. If
  multiple tenants share a workload, they each get their own quota. If a single tenant
  has triggers across multiple workloads, they all count toward one limit. This seems
  right for the "personal assistant" use case but may need revisiting for multi-agent
  orchestration.
- **Bot token injection:** Rather than trusting agents to provide `botToken` in
  replyContext, the agent-triggers API should resolve it from the originating trigger's
  config. This requires knowing which trigger initiated the current session — needs a
  `originatingTriggerId` or `originatingTriggerName` field on the tenant claim or
  session context.
