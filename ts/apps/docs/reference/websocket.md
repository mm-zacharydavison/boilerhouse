# WebSocket Events Reference

Boilerhouse exposes a WebSocket endpoint for real-time domain events.

## Connecting

```
ws://localhost:3000/ws?token=YOUR_API_KEY
```

If `BOILERHOUSE_API_KEY` is set, the `token` query parameter is required. Without it, the connection is rejected with `401`.

If no API key is configured, connect without the token parameter:

```
ws://localhost:3000/ws
```

## Protocol

- **Direction:** server-to-client only. Client-to-server messages are ignored.
- **Format:** Each message is a JSON-encoded domain event.
- **Connection:** Standard WebSocket. Reconnect on disconnect — there is no message buffering.

## Event Types

All events have a `type` field identifying the event kind. Additional fields depend on the type.

### Instance Events

#### `instance.transition`

An instance changed status.

```json
{
  "type": "instance.transition",
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz",
  "from": "starting",
  "to": "active"
}
```

### Tenant Events

#### `tenant.claimed`

A tenant claimed an instance.

```json
{
  "type": "tenant.claimed",
  "tenantId": "alice",
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz",
  "source": "pool"
}
```

#### `tenant.released`

A tenant's claim was released.

```json
{
  "type": "tenant.released",
  "tenantId": "alice",
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz"
}
```

### Idle Events

#### `idle.timeout`

An instance's idle timeout fired.

```json
{
  "type": "idle.timeout",
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz",
  "tenantId": "alice"
}
```

### Trigger Events

#### `trigger.dispatched`

A trigger dispatched an event to a container.

```json
{
  "type": "trigger.dispatched",
  "triggerId": "trg_abc",
  "tenantId": "tg-alice",
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz"
}
```

### Pool Events

#### `pool.acquired`

An instance was acquired from a pool.

```json
{
  "type": "pool.acquired",
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz"
}
```

#### `pool.replenished`

A new instance was added to a pool.

```json
{
  "type": "pool.replenished",
  "instanceId": "inst_def456",
  "workloadId": "wkl_xyz"
}
```

## Example Client

### JavaScript

```javascript
const ws = new WebSocket("ws://localhost:3000/ws?token=my-key");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data);
};

ws.onclose = () => {
  // Reconnect after delay
  setTimeout(() => connect(), 1000);
};
```

### CLI (wscat)

```bash
npx wscat -c "ws://localhost:3000/ws?token=my-key"
```
