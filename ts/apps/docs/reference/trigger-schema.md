# Trigger Schema Reference

Complete reference for `BoilerhouseTrigger.spec`. The authoritative schema is generated from `go/api/v1alpha1/trigger_types.go`.

## Top-Level Structure

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: <string>
  namespace: boilerhouse
spec:
  type: <TriggerType>      # required
  workloadRef: <string>    # required
  tenant: <TenantMapping>
  driver: <string>
  driverOptions: <map>
  guards: <GuardStep[]>
  config: <AdapterConfig>
```

---

## `spec.type`

- **Type:** `string` — one of `webhook`, `slack`, `telegram`, `cron`
- **Required:** yes

Determines which adapter handles events and which `config` shape is expected.

## `spec.workloadRef`

- **Type:** `string`
- **Required:** yes

Name of the `BoilerhouseWorkload` to claim when the trigger fires.

---

## `spec.tenant`

How to resolve the tenant ID from the incoming event.

### Static Mapping

Always maps to the same tenant:

```yaml
tenant:
  static: system-user
```

### Field Mapping

Extracts the tenant ID from the event:

```yaml
tenant:
  from: userId
```

```yaml
tenant:
  from: usernameOrId
  prefix: "tg-"
```

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Field to extract from the parsed event |
| `prefix` | string | Optional prefix prepended to the extracted value |
| `static` | string | Literal tenant ID (mutually exclusive with `from`) |

Available fields per adapter:

| Adapter | Fields |
|---------|--------|
| Webhook | Any JSON body field path |
| Telegram | `chatId`, `userId`, `usernameOrId` |
| Cron | N/A (use `static`) |

---

## `spec.config`

Adapter-specific configuration. `kubebuilder:pruning:PreserveUnknownFields` is set so you can embed free-form config here — the operator passes it to the appropriate adapter.

### Webhook

```yaml
config:
  path: /hooks/deploy
  secretRef:
    name: webhook-hmac
    key: secret
  rateLimit:
    max: 10
    windowSeconds: 60
```

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | URL path the gateway serves |
| `secretRef` | SecretKeyRef | Optional HMAC-SHA256 secret for `X-Hub-Signature-256` verification |
| `rateLimit.max` | integer | Max requests per window |
| `rateLimit.windowSeconds` | integer | Window size in seconds |

### Telegram

```yaml
config:
  botTokenSecretRef:
    name: telegram-bot-token
    key: token
  updateTypes: [message]
  pollTimeoutSeconds: 30
```

| Field | Type | Description |
|-------|------|-------------|
| `botTokenSecretRef` | SecretKeyRef | Bot token from a Kubernetes Secret |
| `updateTypes` | string[] | Telegram update types to handle |
| `pollTimeoutSeconds` | integer | Long-poll timeout |
| `apiBaseUrl` | string | Custom Telegram API URL |

### Cron

```yaml
config:
  schedule: "0 2 * * *"
  payload:
    task: cleanup
```

| Field | Type | Description |
|-------|------|-------------|
| `schedule` | string | Cron expression (e.g., `"*/5 * * * *"`) |
| `payload` | map | Static payload sent on each tick |

---

## `spec.driver`

- **Type:** `string`
- **Required:** no

Protocol driver for formatting payloads before sending to the container.

| Value | Protocol |
|-------|----------|
| `claude-code` | Claude Code WebSocket bridge |
| `openclaw` | OpenClaw WebSocket |
| (unset) | Plain HTTP POST JSON to the container's first exposed port |

## `spec.driverOptions`

- **Type:** free-form map
- **Required:** no

Driver-specific configuration.

---

## `spec.guards`

Authorization guards executed before a claim is created. Guards run as a chain — if any guard denies, the trigger is rejected.

```yaml
guards:
  - type: allowlist
    config:
      tenantIds:
        - tg-alice
        - tg-bob
      denyMessage: "Not authorized."
```

### Allowlist Guard

```yaml
- type: allowlist
  config:
    tenantIds: ["tg-alice", "tg-bob"]
    denyMessage: "Not authorized."
```

Matching is case-insensitive.

### API Guard

```yaml
- type: api
  config:
    url: https://api.example.com/auth
    headers:
      Authorization: "Bearer token"
    denyMessage: "Access denied."
```

POSTs `{ tenantId, source }` to `url`. Expected response: `{ "ok": true }` or `{ "ok": false, "message": "reason" }`. Fails closed.

---

## Status

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | `Active` or `Error` |
| `detail` | string | Human-readable phase detail |
