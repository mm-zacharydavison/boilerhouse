# Triggers

Triggers connect external events to Boilerhouse claims. When a Telegram message arrives, a webhook is called, or a cron schedule ticks, the trigger gateway claims an instance for the appropriate tenant and forwards the event.

## How Triggers Work

```
External Event ──► Adapter (parse event) ──► Guard Chain (authorize)
                                                    │
                                              ──► Gateway creates BoilerhouseClaim
                                                    │
                                              ──► Driver (forward to container)
                                                    │
                                              ──► Response back to source
```

1. **Adapter** receives the external event and normalizes it into a trigger payload
2. **Tenant resolution** extracts the tenant ID from the event (e.g., Telegram user ID)
3. **Guard chain** checks authorization (allowlist, API-based)
4. **Gateway** creates a `BoilerhouseClaim` CR and waits for it to become `Active`
5. **Driver** forwards the payload to the container via HTTP or WebSocket
6. **Response** is sent back to the original source

The trigger gateway (`go/cmd/trigger`) runs as its own binary. It watches `BoilerhouseTrigger` CRs and manages one adapter per active trigger.

## Defining a Trigger

Triggers are `BoilerhouseTrigger` Custom Resources:

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: my-webhook
  namespace: boilerhouse
spec:
  type: webhook
  workloadRef: my-agent
  tenant:
    from: userId
  config:
    path: /hooks/my-agent
    secretRef:
      name: webhook-hmac
      key: secret
```

Or create via the API:

```bash
curl -X POST http://localhost:3000/api/v1/triggers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-webhook",
    "spec": {
      "type": "webhook",
      "workloadRef": "my-agent",
      "tenant": {"from": "userId"},
      "config": {"path": "/hooks/my-agent"}
    }
  }'
```

## Built-in Adapters

### Webhook

Generic HTTP webhook handler with optional HMAC-SHA256 signature verification.

```yaml
spec:
  type: webhook
  workloadRef: my-agent
  tenant:
    from: repository.owner
  config:
    path: /hooks/deploy
    secretRef:
      name: webhook-hmac
      key: secret
```

The gateway exposes the configured `path` and validates `X-Hub-Signature-256` if a secret is configured.

### Telegram (Polling)

Long-polls the Telegram Bot API. No inbound endpoint required — secure for environments without public internet exposure.

```yaml
spec:
  type: telegram
  workloadRef: claude-code
  tenant:
    from: usernameOrId
    prefix: "tg-"
  driver: claude-code
  config:
    botTokenSecretRef:
      name: telegram-bot-token
      key: token
    updateTypes: [message]
    pollTimeoutSeconds: 30
```

The adapter:
- Long-polls `getUpdates` with offset tracking
- Resolves the tenant from chat ID, user ID, or username
- Sends responses via `sendMessage`
- Cleans up any existing webhook before starting polling

### Cron

Fires on a schedule using cron syntax.

```yaml
spec:
  type: cron
  workloadRef: my-agent
  tenant:
    static: system
  config:
    schedule: "0 2 * * *"
    payload:
      task: cleanup
```

Cron triggers use `tenant.static` since there's no external event to extract a tenant from.

## Tenant Resolution

Triggers need to determine which tenant an event belongs to. Two strategies:

### Static

Always maps to the same tenant:

```yaml
tenant:
  static: system-user
```

### From Field

Extracts the tenant ID from the event payload:

```yaml
tenant:
  from: userId
```

```yaml
tenant:
  from: usernameOrId
  prefix: "tg-"
```

The `from` value maps to adapter-specific parsed fields:

| Adapter | Available Fields |
|---------|-----------------|
| Webhook | Any field path from the JSON body |
| Telegram | `chatId`, `userId`, `usernameOrId` |
| Cron | N/A (use `static`) |

The optional `prefix` prepends a string to the extracted value (e.g., `userId: "12345"` + `prefix: "tg-"` → tenant ID `tg-12345`).

## Guards

Guards authorize tenants before a claim is created. They run as a chain — if any guard denies, the trigger is rejected.

### Allowlist Guard

Static list of allowed tenant IDs:

```yaml
spec:
  type: telegram
  workloadRef: claude-code
  tenant:
    from: usernameOrId
    prefix: "tg-"
  guards:
    - type: allowlist
      config:
        tenantIds:
          - tg-alice
          - tg-bob
        denyMessage: "You are not authorized to use this agent."
```

Matching is case-insensitive.

### API Guard

Delegates authorization to an external HTTP endpoint:

```yaml
guards:
  - type: api
    config:
      url: https://my-api.example.com/auth/check
      headers:
        Authorization: "Bearer my-token"
      denyMessage: "Access denied."
```

The guard POSTs `{ tenantId, source }` to the URL and expects `{ ok: true }` or `{ ok: false, message }`. It fails closed — network errors, timeouts, and malformed responses all result in denial.

## Drivers

Drivers handle the protocol between the trigger gateway and the container. They format the trigger payload for the specific agent running inside.

```yaml
spec:
  type: telegram
  workloadRef: claude-code
  driver: claude-code
  config: { ... }
```

### Built-in Drivers

| Driver | Protocol | Description |
|--------|----------|-------------|
| `claude-code` | WebSocket | Claude Code bridge protocol |
| `openclaw` | WebSocket | OpenClaw control protocol |
| (omitted) | HTTP | Plain HTTP POST of the normalized payload |

If no driver is specified, the gateway POSTs the trigger payload as JSON to the container's first exposed port.

## Managing Triggers via API

```bash
# List
curl http://localhost:3000/api/v1/triggers

# Get
curl http://localhost:3000/api/v1/triggers/:id

# Create
curl -X POST http://localhost:3000/api/v1/triggers -d '{...}'

# Delete
curl -X DELETE http://localhost:3000/api/v1/triggers/:id
```

Or use `kubectl`:

```bash
kubectl get boilerhousetriggers -n boilerhouse
kubectl delete boilerhousetrigger my-webhook -n boilerhouse
```

## Full Schema Reference

See [Trigger Schema Reference](../reference/trigger-schema) for the complete CRD spec.
