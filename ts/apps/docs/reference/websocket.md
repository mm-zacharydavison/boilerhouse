# WebSocket Events Reference

The API server exposes a single WebSocket endpoint that streams Kubernetes resource change events to connected clients (primarily the dashboard).

## Connecting

```
ws://localhost:3000/ws
```

The `/ws` endpoint is outside the API auth middleware — the dashboard proxy doesn't forward `BOILERHOUSE_API_KEY`. If you need to protect it, run the API behind a reverse proxy that enforces auth at the edge.

## Protocol

- **Direction:** server-to-client only. Client-to-server messages are drained but ignored (used to detect disconnect).
- **Format:** each message is a JSON object.
- **Buffering:** server writes with a 10-second deadline; there is no replay on reconnect.

The server runs two watchers per connection:
- A Pod watcher (filtered by `boilerhouse.dev/managed=true`)
- A `BoilerhouseClaim` watcher (all claims in the namespace)

## Event Types

All events have a `type` field. Additional fields depend on the type.

### `instance.state`

A managed Pod was added, modified, or deleted.

```json
{
  "type": "instance.state",
  "name": "inst-alice-my-agent-a1b2c3",
  "phase": "Running",
  "workloadRef": "my-agent",
  "tenantId": "alice"
}
```

`phase` is the Pod phase (`Pending`, `Running`, `Succeeded`, `Failed`, `Unknown`) or `"Deleted"` when the Pod is removed.

### `pool.instance.ready`

A pool Pod transitioned from `warming` to `ready` (based on the `boilerhouse.dev/pool-status` label).

```json
{
  "type": "pool.instance.ready",
  "name": "inst-my-agent-pool-x1y2z3",
  "workloadRef": "my-agent"
}
```

### `tenant.claimed`

A `BoilerhouseClaim` transitioned to phase `Active`.

```json
{
  "type": "tenant.claimed",
  "name": "claim-alice-my-agent",
  "tenantId": "alice",
  "workloadRef": "my-agent",
  "source": "pool"
}
```

### `tenant.released`

A claim transitioned to phase `Released` or was deleted.

```json
{
  "type": "tenant.released",
  "name": "claim-alice-my-agent",
  "tenantId": "alice"
}
```

## Example Client

### JavaScript

```javascript
const ws = new WebSocket("ws://localhost:3000/ws");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data);
};

ws.onclose = () => {
  setTimeout(connect, 1000);
};
```

### CLI (wscat)

```bash
npx wscat -c ws://localhost:3000/ws
```

## Notes on Reconnection

Neither the server nor the Kubernetes watch API replays events from a historical point. On reconnect, do a snapshot `GET` (`/api/v1/instances`, `/api/v1/tenants`) to rebuild current state, then resume streaming from the WebSocket. The dashboard implements this pattern.
