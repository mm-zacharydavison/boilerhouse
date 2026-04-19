# API Guard — Design Spec

## Goal

Add a new trigger guard type, `api`, that delegates the allow/deny decision for an incoming trigger event to an external HTTP service. Complements the existing `allowlist` guard for use cases that need dynamic checks (quota, per-tenant flags, external authz) instead of a static tenant list.

## Scope

- One new guard type: `type: api`.
- No changes to the `Guard` interface or the `BoilerhouseTrigger` CRD shape (the existing `TriggerGuard { type, config }` is sufficient).
- No telemetry, caching, or circuit-breaker work — fail-closed with logs is enough for the first cut.
- No payload mutation / rewriting — guards remain pure gatekeepers.

## Architecture

`APIGuard` lives in a new file `go/internal/trigger/guard_api.go`, alongside `AllowlistGuard` in `guard.go`. It implements the existing interface:

```go
type Guard interface {
    Check(ctx context.Context, tenantId string, payload TriggerPayload) error
}
```

Wired into the gateway by adding a `case "api"` branch to the switch in `Gateway.buildGuards` at `go/internal/trigger/gateway.go:211`. Parsing/construction lives in `guard_api.go` (`parseAPIGuard`), mirroring the existing `parseAllowlistGuard` helper.

Event flow (unchanged): `Gateway.Handle` iterates guards in spec order and calls `Check`. Any non-nil error rejects the event; the error message surfaces to the trigger caller.

## Config

Declared on `BoilerhouseTrigger.spec.guards` using the existing `type`/`config` shape:

```yaml
guards:
  - type: api
    config:
      url: https://guard.internal/check   # required, must be absolute http(s)
      timeoutMs: 2000                      # optional, default 2000, must be > 0 if set
      secretRef:                           # optional; enables bearer-token auth
        name: guard-api-token              # Secret in the operator's namespace
        key: token                         # key within the Secret's data map
```

Parsed shape:

```go
type apiGuardConfig struct {
    URL       string     `json:"url"`
    TimeoutMs int        `json:"timeoutMs,omitempty"`
    SecretRef *secretRef `json:"secretRef,omitempty"`
}
type secretRef struct {
    Name string `json:"name"`
    Key  string `json:"key"`
}
```

### Validation

Validation runs at `buildGuards` time. A guard with invalid config is still constructed, but in a "misconfigured" state that denies every event with `"guard misconfigured: <reason>"`. We fail closed on misconfig for consistency with the runtime failure mode.

Invalid cases:

- missing/empty `url`
- `url` that does not parse as an absolute `http://` or `https://` URL
- `timeoutMs <= 0` when set
- `secretRef` set with `name` or `key` empty
- Secret load failure when `secretRef` is set (see Error handling)

## Request / response contract

### Request

`POST <url>` with:

- `Content-Type: application/json`
- `User-Agent: boilerhouse-trigger-gateway`
- `Authorization: Bearer <token>` — only when `secretRef` is set

Body:

```json
{
  "triggerName": "gh-webhook",
  "tenantId": "acme",
  "payload": { }
}
```

`payload` is the full `TriggerPayload` as the gateway received it (same type the existing guards and adapters see).

### Response

Must be HTTP `200` with JSON body:

```json
{ "allow": true }
// or
{ "allow": false, "reason": "tenant acme over quota" }
```

Handling:

- `allow == true` → `Check` returns `nil`.
- `allow == false` → `Check` returns an error whose message is the `reason`, trimmed and capped at 256 characters. If `reason` is absent or empty, message is `"denied by api guard"`.
- Any other outcome — non-200 status, network error, context deadline, non-JSON body, missing `allow` field — fails closed: `Check` returns `"api guard unreachable: <underlying>"`.

## Error handling

### Failure mode

**Fail closed always.** Transport failures, timeouts, malformed responses, and misconfig all deny the event. Not user-configurable — a broken guard never lets events through.

### Secret loading

When `secretRef` is set, the token is read via the gateway's existing controller-runtime client (the same client used to look up Claims) at `buildGuards` time and cached on the `APIGuard` struct. `buildGuards` already runs per event, so "load at build time" is effectively per-event; this keeps `Check` synchronous and pure-HTTP and avoids wiring a second client path.

On Secret read failure (not found, missing key, RBAC denied), the guard is constructed in misconfigured state and every event denies with `"guard secret unavailable: <reason>"`.

### HTTP client

`APIGuard` holds an `*http.Client` shared across calls (injectable for tests). The per-call timeout is applied via `context.WithTimeout` inside `Check`, not on the client itself, so the client stays reusable and tests can drive it with `httptest.NewServer` without fighting client-level timeouts.

### Deny vs error

Both surface as a non-nil `Check` error today; the gateway treats any guard error as reject. We keep that. No interface change. Telemetry/logging can add a typed sentinel later if we want to distinguish deny from infrastructure failure in metrics — not in scope here.

### Logging

- Deny: `info` level with `triggerName`, `tenantId`, `reason`.
- Fail-closed: `warn` level with `triggerName`, `tenantId`, underlying error.
- Payload contents are **not** logged.

## Testing

### Unit tests — `go/internal/trigger/guard_api_test.go`

Mirror the style of `adapter_telegram_test.go` and the `AllowlistGuard` tests in `gateway_test.go`. Each test stands up an `httptest.Server` with the required handler and constructs an `APIGuard` pointing at it.

Cases:

- **Allow path** — server returns `{"allow":true}`; `Check` returns `nil`.
- **Deny with reason** — server returns `{"allow":false,"reason":"over quota"}`; `Check` returns an error whose message contains `"over quota"`.
- **Deny without reason** — defaults to `"denied by api guard"`.
- **Reason truncation** — oversized `reason` (> 256 chars) is trimmed.
- **Timeout** — server sleeps past `timeoutMs`; `Check` fails closed.
- **Non-200 response** — 500 and 404 both fail closed with an "unreachable" message.
- **Malformed JSON body** — fails closed.
- **Missing `allow` field** — fails closed.
- **Auth header present** — when `secretRef` provided, server asserts `Authorization: Bearer <token>`.
- **Auth header absent** — when no `secretRef`, `Authorization` header not set.
- **Config parsing** — missing/invalid `url`, `timeoutMs <= 0`, partial `secretRef` each produce a misconfigured guard that denies with `"guard misconfigured"`.

### Integration test — add to `go/internal/trigger/gateway_test.go`

One envtest-backed test that `buildGuards` on a `BoilerhouseTrigger` with `type: api` (pointing at a real `httptest.Server`) produces a working guard, and that `Gateway.Handle` accepts/rejects a fake event through it end to end. Covers the Secret-loading path by creating a real `Secret` in the test namespace and referencing it via `secretRef`.

No envtest needed for `APIGuard` itself — the unit tests cover the HTTP behavior in isolation.

## Non-goals

- Batching / caching of guard decisions.
- mTLS, OIDC, or non-bearer auth schemes.
- Async or webhook-style guards (all guards are sync request/response).
- Payload mutation or tenant rewriting by the guard service.
- Per-guard configurable failure mode (`failOpen`). Always fail closed.
