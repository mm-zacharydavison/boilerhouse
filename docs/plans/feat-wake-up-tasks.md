# Wake-Up Tasks — Agent-Created Triggers (Go/K8s)

## Status

### Already Implemented
- **Scoped API token framework**: `go/internal/scope/scope.go` — `AgentTriggersRead` and `AgentTriggersWrite` scopes defined, included in `DefaultAgentScopes`.
- **Auth middleware + token store**: `go/internal/api/server.go:176-212` — `authMiddleware` validates Bearer tokens via `TokenStore.Lookup()`.
- **Trigger routes with scope enforcement**: `go/internal/api/server.go:121-124` — `/triggers` endpoints mount with `requireScope`.
- **Trigger CRUD handlers**: `go/internal/api/routes_trigger.go` — `createTrigger`, `listTriggers`, `getTrigger`, `deleteTrigger` with tenant/workload isolation.
- **Scoped callers restricted to cron**: `go/internal/api/routes_trigger.go:64-77` — scoped callers already restricted to `cron` type; foundation for agent-triggers whitelist.
- **Gateway trigger sync + adapter dispatch**: `go/internal/trigger/gateway.go:55-76` — Sync method and `buildAdapter` switch handle webhook/cron/telegram types.

### Outstanding
1. Add `one-shot` to trigger type enum — `go/api/v1alpha1/trigger_types.go:35`.
2. Create `go/internal/trigger/adapter_one_shot.go` — `OneShotAdapter` struct with `runAt`, `payload`, context cancel; `Start()` sleeps until runAt then fires handler exactly once.
3. Create `go/internal/trigger/adapter_one_shot_test.go` — fire-on-time, late-fire, context cancellation.
4. Extend `gateway.buildAdapter` switch with `case "one-shot":` — `go/internal/trigger/gateway.go` around line 184.
5. Create `parseOneShotConfig` helper in `gateway.go` — parse `Spec.Config` for `{runAt: RFC3339, payload: object}`.
6. Create `go/internal/trigger/reply.go` — `ReplyContext` struct and `SendReply()` function; wire into `buildHandler` after `driver.Send`.
7. Set `boilerhouse.io/originating-trigger` annotation on Claims — modify `ensureClaim` in `gateway.go:291-302`.
8. Create `go/internal/api/agent_trigger_policy.go` — `AgentTriggerPolicy` struct and `DefaultAgentTriggerPolicy`.
9. Create `go/internal/api/routes_agent_triggers.go` — POST/GET/DELETE handlers with type whitelist, cron interval validation, one-shot time validation, count cap, tenant isolation, bot-token resolution from originating trigger.
10. Create `go/internal/api/routes_agent_triggers_test.go` — scope enforcement, tenant isolation, count cap, type whitelist, cron interval, one-shot time, originating-trigger resolution.
11. Mount new routes in `go/internal/api/server.go`.
12. Regenerate CRD manifests via `controller-gen` after enum change.

**Dependency:** Container-scoped API keys (feat-container-scoped-api-keys.md) is **complete** — `AuthContext` and `TokenStore` are available.

---

**Goal:** Allow agents (tenants) to create their own triggers from within a running session — e.g. "remind me in 2 hours", "check deployment status every 5 minutes", "run a daily summary at 9am".

**Dependency:** [Container-Scoped API Keys](feat-container-scoped-api-keys.md) — agents need an authenticated, scoped key to call the Boilerhouse API. That plan provisions per-Claim Secrets with RBAC scopes. This plan requires the `agent-triggers:read` and `agent-triggers:write` scopes.

**Design principles:**

1. **Triggers are CRDs.** An agent-created trigger is just a `BoilerhouseTrigger` CR with `origin=agent` labels. The trigger gateway (`go/internal/trigger/gateway.go`) already watches all triggers; agent-created ones get picked up automatically. No new control plane, no parallel scheduler.
2. **Constrained API.** Agents get a limited subset — only `cron` and `one-shot` types, with enforced minimum intervals, max count per tenant, scoped to their own tenant + workload.
3. **Origin label, not status field.** `boilerhouse.io/origin: agent` and `boilerhouse.io/created-by-tenant: <id>` as labels. The dashboard filters by selector; no schema change beyond these.
4. **Authenticated via the per-Claim Secret token.** The agent uses `BOILERHOUSE_API_KEY` injected by the ClaimReconciler. The auth middleware resolves the key's scope and tenant.
5. **One-shot is a new trigger type.** `spec.type=one-shot` plus `spec.config.runAt`. Handled by extending the existing cron adapter loop, not by a new adapter binary.

---

## Architecture

```
Agent (inside Pod)
  → reads BOILERHOUSE_API_KEY + BOILERHOUSE_API_URL from env
  → POST /api/v1/agent-triggers { type, schedule|runAt, payload, label, replyContext }
  → API server:
      authMiddleware → AuthContext{Scoped, tenantId, workload, ...}
      requireScope(agent-triggers:write)
      validate (type whitelist, intervals, counts, future-only)
      look up originating trigger config to copy bot tokens (security note)
      Create BoilerhouseTrigger CR with:
        labels: boilerhouse.io/origin=agent, boilerhouse.io/created-by-tenant=<id>
        spec: tenant.static=<tenantId>, workloadRef=<authContext.Workload>
              type=cron|one-shot, config={schedule|runAt, payload, replyContext}
        status.phase=Active (so the gateway picks it up immediately)

  → trigger gateway picks it up on next sync (≤10s, see gateway.go:19 syncInterval)
  → cron/one-shot adapter dispatches at the scheduled time
  → result routed via replyContext (Telegram chatId, etc.)
```

The agent doesn't see CRD internals — it just says "wake me up at this time with this context".

---

## CRD Changes

### `go/api/v1alpha1/trigger_types.go`

The current `BoilerhouseTriggerSpec.Type` enum is `webhook;slack;telegram;cron`. Add `one-shot`:

```go
// +kubebuilder:validation:Enum=webhook;slack;telegram;cron;one-shot
Type string `json:"type"`
```

No new fields on the Spec — `runAt` and `payload` ride inside `Spec.Config` (already a `*runtime.RawExtension`). This keeps the CRD shape simple and uses the existing per-type config parser pattern in `gateway.go:298-342`.

### Labels (no schema change)

Standard label conventions:
- `boilerhouse.io/origin`: `admin` (default) or `agent`
- `boilerhouse.io/created-by-tenant`: `<tenantId>` when origin=agent
- `boilerhouse.io/originating-trigger`: `<adminTriggerName>` (the trigger that started the session this agent is in)

These let the dashboard select agent triggers without parsing every CR's spec.

---

## Agent Trigger Policy

Defined in code, configurable later via env or a CRD-backed Settings resource:

```go
// go/internal/api/agent_trigger_policy.go
type AgentTriggerPolicy struct {
    AllowedTypes              []string      // ["cron", "one-shot"]
    MinCronInterval           time.Duration // 5 * time.Minute
    MaxTriggersPerTenant      int           // 10
    MaxOneShotHorizon         time.Duration // 30 * 24 * time.Hour
    MinOneShotDelay           time.Duration // 1 * time.Minute
}

var DefaultAgentTriggerPolicy = AgentTriggerPolicy{
    AllowedTypes:         []string{"cron", "one-shot"},
    MinCronInterval:      5 * time.Minute,
    MaxTriggersPerTenant: 10,
    MaxOneShotHorizon:    30 * 24 * time.Hour,
    MinOneShotDelay:      1 * time.Minute,
}
```

Defaults match the original plan. Read overrides from env vars in `cmd/api/main.go`.

---

## API Routes

### New file: `go/internal/api/routes_agent_triggers.go`

Mounted in `server.go:buildRouter` inside the auth group:

```go
r.Post("/agent-triggers", s.createAgentTrigger)
r.Get("/agent-triggers", s.listAgentTriggers)
r.Delete("/agent-triggers/{name}", s.deleteAgentTrigger)
```

#### `POST /api/v1/agent-triggers`

Request body:

```go
type AgentTriggerRequest struct {
    Type         string                 `json:"type"`         // "cron" | "one-shot"
    Schedule     string                 `json:"schedule,omitempty"`     // cron expression
    RunAt        string                 `json:"runAt,omitempty"`        // RFC3339
    Payload      map[string]any         `json:"payload,omitempty"`
    Label        string                 `json:"label"`        // required
    ReplyContext map[string]any         `json:"replyContext,omitempty"`
}
```

Handler steps:

1. `RequireScope(ctx, ScopeAgentTriggersWrite)` — bail 403 on miss.
2. Validate `req.Type` ∈ policy.AllowedTypes.
3. If `cron`: parse with `github.com/robfig/cron/v3`, compute next two firings, reject if interval < `MinCronInterval`.
4. If `one-shot`: parse `runAt` as RFC3339, ensure `now + MinOneShotDelay <= runAt <= now + MaxOneShotHorizon`.
5. Count existing CRs with selector `boilerhouse.io/origin=agent,boilerhouse.io/created-by-tenant=<tenantId>`. Reject if `>= MaxTriggersPerTenant`.
6. Resolve `workloadRef` from `AuthContext.Workload` — agent cannot retarget.
7. Resolve bot token / reply config from the **originating trigger** (via `boilerhouse.io/originating-trigger` annotation on the Claim, see security section). Agents do **not** supply bot tokens.
8. Build a `BoilerhouseTrigger` CR with a generated name `agent-<tenantId>-<short-uuid>`, labels above, `Spec.Tenant.Static=tenantId`, `Spec.WorkloadRef=workloadRef`, `Spec.Config={schedule|runAt, payload, replyContext}`, `Status.Phase=Active`.
9. `client.Create(ctx, &trigger)`.
10. Return 201 with the trigger summary.

#### `GET /api/v1/agent-triggers`

Lists CRs with selector `boilerhouse.io/origin=agent,boilerhouse.io/created-by-tenant=<authContext.tenantId>`. Returns a flat array of `{name, type, schedule|runAt, label, createdAt, lastInvokedAt}`.

#### `DELETE /api/v1/agent-triggers/{name}`

Loads the CR, verifies labels match the calling tenant (else 403), `client.Delete`. The trigger gateway sees its absence on next sync and stops the adapter.

---

## One-Shot Adapter

**File:** `go/internal/trigger/adapter_cron.go` (extended) — or new `adapter_one_shot.go`.

Currently `CronAdapter` takes `(interval time.Duration, payload string)` and ticks. For one-shot:

```go
// go/internal/trigger/adapter_one_shot.go
type OneShotAdapter struct {
    runAt   time.Time
    payload string
    cancel  context.CancelFunc
    doneCh  chan struct{}
}

func NewOneShotAdapter(runAt time.Time, payload string) *OneShotAdapter { ... }

func (a *OneShotAdapter) Start(ctx context.Context, handler EventHandler) error {
    ctx, a.cancel = context.WithCancel(ctx)
    defer close(a.doneCh)

    delay := time.Until(a.runAt)
    if delay < 0 {
        // Past due — fire immediately.
        delay = 0
    }
    select {
    case <-ctx.Done():
        return nil
    case <-time.After(delay):
        payload := TriggerPayload{Text: "", Source: "one-shot", Raw: a.payload}
        if _, err := handler(ctx, payload); err != nil {
            return err
        }
    }
    // After firing, the trigger should be deleted.
    // The gateway's syncOnce will see we returned and won't restart us.
    // Disable the CR here? See "After-fire cleanup" below.
    return nil
}
```

In `gateway.go:buildAdapter`:

```go
case "one-shot":
    cfg := parseOneShotConfig(trigger)
    runAt, err := time.Parse(time.RFC3339, cfg.RunAt)
    if err != nil {
        return nil, fmt.Errorf("invalid runAt %q: %w", cfg.RunAt, err)
    }
    payload, _ := json.Marshal(cfg.Payload)
    return NewOneShotAdapter(runAt, string(payload)), nil
```

### After-fire cleanup

Two options:

- **(A) Adapter deletes the CR after firing.** Requires the adapter to hold a `client.Client` reference — currently it doesn't. Adds coupling.
- **(B) Adapter sets `Status.Phase = "Fired"` and the gateway treats anything ≠ Active as inactive.** The CR sits in the cluster as history; a separate cleanup reconciler GCs `Fired` triggers older than 7 days.

Recommend (B). The gateway already filters on `Status.Phase != "Active"` (line 95). Add a small `cleanupOldFiredTriggers` reconciler (or even just a daily K8s CronJob running `kubectl delete triggers -l boilerhouse.io/origin=agent,status.phase=Fired --field-selector=...`).

---

## Bot-Token Plumbing (Security)

The original TS plan stored bot tokens on the trigger row, which agents could supply directly — explicitly flagged as wrong. Fix:

- The ClaimReconciler annotates the Claim with `boilerhouse.io/originating-trigger: <name>` when a trigger calls `ensureClaim` (gateway.go:225). Modify `ensureClaim` to set this annotation.
- The agent-triggers POST handler reads `AuthContext.ClaimID` (from the per-Claim API key), Gets the Claim, reads the `originating-trigger` annotation, Gets that admin trigger, copies its bot-token and reply config into the new agent trigger's `replyContext`.
- The agent never names a bot token in the request body. If they try, ignore it.

This means: an agent can only reply via the same channel that initiated their session. They can't smuggle in a different bot or DM another user.

---

## Reply Context Storage

`replyContext` rides in `Spec.Config.replyContext`. When the cron/one-shot adapter fires, the existing `gateway.buildHandler` flow runs and `driver.Send` returns a result. Reply routing is done by the adapter (telegram adapter sends back to `chatId` from `parsed.ChatID` — `adapter_telegram.go:222-228`).

For agent-created triggers, the *firing* doesn't go back through telegram — it goes through cron/one-shot. So the handler needs to know to fan the result to a Telegram chat. New shape: after `driver.Send`, if `trigger.Spec.Config.replyContext.adapter == "telegram"`, call `sendTelegramMessage` directly with the response text.

This means the cron/one-shot handler knows about telegram. To keep boundaries clean, abstract it:

```go
// go/internal/trigger/reply.go (new)
type ReplyContext struct {
    Adapter   string `json:"adapter"`
    ChatID    *int64 `json:"chatId,omitempty"`
    BotToken  string `json:"botToken,omitempty"`
    APIBaseURL string `json:"apiBaseUrl,omitempty"`
}

func SendReply(ctx context.Context, rc *ReplyContext, response any) error {
    if rc == nil { return nil }
    text := extractResponseText(response)
    if text == "" { return nil }
    switch rc.Adapter {
    case "telegram":
        return sendTelegramMessageRaw(ctx, rc.APIBaseURL, rc.BotToken, *rc.ChatID, text)
    default:
        return fmt.Errorf("unsupported reply adapter: %s", rc.Adapter)
    }
}
```

Wire into `buildHandler` (gateway.go:177): after `driver.Send`, if the trigger config has a `replyContext`, call `SendReply`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `go/api/v1alpha1/trigger_types.go` | Modify | Add `one-shot` to type enum |
| `go/internal/api/agent_trigger_policy.go` | Create | Policy struct + defaults |
| `go/internal/api/routes_agent_triggers.go` | Create | POST/GET/DELETE handlers + validation |
| `go/internal/api/routes_agent_triggers_test.go` | Create | Validation, scope, tenant isolation, count cap |
| `go/internal/api/server.go` | Modify | Mount the new routes |
| `go/internal/trigger/adapter_one_shot.go` | Create | One-shot adapter |
| `go/internal/trigger/adapter_one_shot_test.go` | Create | Fire-on-time, late-fire, ctx cancel |
| `go/internal/trigger/gateway.go` | Modify | `case "one-shot":` in buildAdapter, originating-trigger annotation in ensureClaim |
| `go/internal/trigger/reply.go` | Create | `ReplyContext`, `SendReply` |
| `go/internal/operator/claim_controller.go` | Modify | Set `originating-trigger` annotation on Active transition |
| `config/crd/bases-go/*trigger*.yaml` | Regenerate | Via `make manifests` |

---

## Sequencing

1. CRD enum addition — pure types.
2. `AgentTriggerPolicy` + helpers.
3. `OneShotAdapter` + tests in isolation.
4. `gateway.go` extension for one-shot type.
5. `reply.go` + wire `SendReply` into `buildHandler`.
6. Agent-triggers route + tests (uses envtest + httptest, no real cluster).
7. Originating-trigger annotation in ClaimReconciler.
8. Cleanup reconciler / CronJob for `Fired` triggers (follow-up).

Items 1-3 in parallel. Items 4-5 sequential. Item 6 depends on container-scoped-api-keys plan being done (otherwise no `AuthContext` to enforce against).

---

## Security Recap

- **AuthN:** per-Claim bearer token, validated by `authMiddleware`.
- **AuthZ:** `RequireScope(ScopeAgentTriggersWrite)` + label-selector filtering.
- **Tenant isolation:** new CRs inherit `tenant.static = authContext.tenantId`. Listing/deleting filters by `created-by-tenant` label.
- **Workload pinning:** `workloadRef = authContext.Workload`. Agent cannot fan into another workload.
- **Bot token:** copied from originating admin trigger. Agent never supplies it. They cannot DM arbitrary chats.
- **Quota:** `MaxTriggersPerTenant` enforced via label selector count before insert.
- **Type whitelist:** Only `cron` and `one-shot`. No telegram/webhook/slack — those carry secrets.
- **Audit:** every creation/deletion logged with `tenantId`, trigger name. K8s `Event` resources can be added if richer auditing is needed.

---

## Example — "remind me to check the deploy in 2 hours"

```
Agent in container with env BOILERHOUSE_API_KEY=ek_xxx, BOILERHOUSE_API_URL=http://boilerhouse-api...

Agent: POST /api/v1/agent-triggers
  Authorization: Bearer ek_xxx
  Body: {
    "type": "one-shot",
    "runAt": "2026-04-19T18:30:00Z",
    "label": "Reminder: check the deploy",
    "payload": { "task": "the user asked to be reminded to check the deploy" }
  }

API:
  - authMiddleware → AuthContext{Scoped, tenant=tg-12345, workload=assistant, claim=trigger-assistant-tg-12345}
  - RequireScope(agent-triggers:write) ✓
  - validate (one-shot, runAt 2h future, count <10) ✓
  - Get Claim trigger-assistant-tg-12345
  - Read annotation originating-trigger=tg-bot-main
  - Get BoilerhouseTrigger tg-bot-main → copy botToken + apiBaseUrl into replyContext
  - Create BoilerhouseTrigger agent-tg-12345-a1b2 with labels & spec
  - 201

  → Gateway sync (≤10s) starts OneShotAdapter
  → After 2h: handler fires, payload reaches workload "assistant"
  → driver.Send returns "Hey! Time to check the deploy."
  → SendReply via Telegram → user sees the message in the same chat
  → trigger Status.Phase=Fired → gateway stops the adapter → cleanup reconciler deletes after 7 days
```

---

## Open Questions

- **PATCH on agent triggers:** start with create/delete only.
- **Quota across workloads vs per-workload:** current design counts all of a tenant's triggers globally. Reasonable for the personal-assistant case; revisit for multi-workload tenants.
- **Cron parser library:** use `github.com/robfig/cron/v3` (5 or 6 field) or a stricter standard-cron parser. Lean toward 5-field standard cron for predictability.
- **One-shot drift:** if the operator restarts shortly before runAt, the gateway resync (≤10s) may fire late. Acceptable for "remind me" granularity. For tighter SLAs, gate on `runAt - now > syncInterval` and warn agents.
- **Visibility in dashboard:** add a filter chip "Agent triggers" using the label selector. No URL or schema change needed.
