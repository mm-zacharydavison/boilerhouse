# WebSocket Workloads Plan

## Context

Boilerhouse triggers currently use stateless HTTP POST per message — each external event
(Slack message, Telegram message, webhook) results in an independent request to the
container. There is no concept of a persistent session between the trigger adapter and
the container.

This works fine for one-shot invocations but breaks down for conversational use cases.
When a Telegram user sends 5 messages to an agent, each one arrives as an isolated POST.
The container has no way to correlate them without implementing its own session management.

Boilerhouse is a generic container platform — containers can be AI agents, game servers,
REPLs, or anything else. We should not impose agent-specific semantics (like chat history)
at the platform level. Instead, we provide a **transparent persistent channel** that
containers can opt into.

## Design

### Workload-level opt-in

Workloads declare WebSocket support in their configuration. If declared, the trigger layer
uses a persistent WebSocket connection instead of HTTP POST per message.

```typescript
// In workload config (packages/core/src/workload.ts)
{
  name: "my-agent",
  version: "1.0.0",
  image: { ref: "my-agent:latest" },
  resources: { vcpus: 1, memory_mb: 512 },
  network: {
    access: "outbound",
    expose: [{ guest: 8080, host_range: [30000, 30099] }],
    // New field — path where the container accepts WebSocket upgrades.
    // Absent = no WebSocket support (current HTTP POST behavior).
    websocket: "/ws"
  },
  // ...
}
```

The `websocket` field is a path on the container's exposed port. When present, the trigger
layer knows it can open a persistent WebSocket connection to this container instead of
making individual HTTP requests.

### Trigger dispatch behavior

The dispatcher checks the workload config and branches:

```
incoming message for tenant T, workload W:

if W.network.websocket is set:
  session = sessionManager.get(T)
  if session exists and session.ws is open:
    session.ws.send(message)
    await response
  else:
    claim tenant T for workload W → endpoint
    ws = new WebSocket(`ws://${endpoint.host}:${endpoint.port}${W.network.websocket}`)
    sessionManager.set(T, ws)
    ws.send(message)
    await response
else:
  // Current behavior — stateless HTTP POST
  claim tenant T for workload W → endpoint
  POST payload to endpoint
  return response
```

### Session manager

The `SessionManager` lives in the trigger layer (`apps/triggers/`). It maintains a map
of active WebSocket connections keyed by tenant ID.

```typescript
class SessionManager {
  private sessions: Map<string, WebSocket> = new Map();

  /** Get or create a WebSocket session for a tenant. */
  async getOrCreate(
    tenantId: string,
    endpoint: { host: string; port: number },
    wsPath: string,
  ): Promise<WebSocket>

  /** Send a message and wait for the response. */
  async send(tenantId: string, message: unknown): Promise<unknown>

  /** Remove a session (called on WS close). */
  remove(tenantId: string): void

  /** Close all sessions (called on shutdown). */
  closeAll(): void
}
```

**Lifecycle:**

- **Creation**: First message for a tenant opens a WebSocket after claim.
- **Reuse**: Subsequent messages for the same tenant reuse the open WebSocket.
  The claim API is still called (to keep the tenant active / prevent idle hibernation),
  but the existing WebSocket is used for message delivery.
- **Cleanup**: When the WebSocket closes (container hibernated, destroyed, crashed),
  the session is removed. The next message will re-claim and open a new connection.
- **Shutdown**: `closeAll()` on process exit.

### Message framing

Boilerhouse does **not** interpret WebSocket frames. It is a transparent pipe. The
trigger adapter serializes the external event as JSON and sends it as a text frame.
The container's response (text frame) is relayed back to the external channel.

```
Telegram → trigger adapter → JSON text frame → WebSocket → container
container → JSON text frame → WebSocket → trigger adapter → Telegram
```

The container decides what the messages mean. An AI agent might treat them as chat
messages. A game server might treat them as commands. Boilerhouse doesn't care.

### Request-response correlation

For HTTP POST, correlation is trivial — one request, one response. For WebSocket,
we need to match responses to requests. Two options:

**Option A: Sequential (MVP)**
One message at a time per session. Send a message, wait for the next incoming frame
as the response. Simple, no protocol overhead.

**Option B: ID-based correlation**
Each outgoing message includes an `id` field. The container echoes it in the response.
This allows concurrent messages on one WebSocket.

```
→ { "id": "msg-1", "payload": { "text": "hello" } }
← { "id": "msg-1", "payload": { "text": "hi there!" } }
```

Start with Option A. Move to Option B if we need concurrency per session.

### Extracting workload config at dispatch time

The dispatcher currently only knows the workload **name** (from the trigger definition).
It needs to look up whether the workload has a `websocket` path configured.

Options:

1. **Trigger definition includes it**: Add an optional `websocket` field to the trigger
   config. Simple but duplicates information.

2. **Fetch from API**: The dispatcher calls `GET /api/v1/workloads/:name` to get the
   full config. Cache it with a short TTL.

3. **Claim response includes it**: Extend the claim API response to include the
   workload's WebSocket path (if any). The trigger layer doesn't need an extra call.

**Recommendation**: Option 3. The claim API already returns the endpoint. Adding the
WebSocket path to the response is minimal and avoids extra round-trips:

```typescript
interface ClaimResult {
  tenantId: string;
  instanceId: string;
  endpoint: { host: string; port: number };
  source: string;
  latencyMs: number;
  // New — present if workload declares websocket support
  websocket?: string;
}
```

### Interaction with idle/hibernation

When a container hibernates due to idle timeout:

1. The WebSocket connection closes (container is gone).
2. `SessionManager` removes the session on the `close` event.
3. Next message triggers a new claim → container restores from snapshot → new WebSocket.

The container sees a fresh WebSocket connection after restore. If it needs to maintain
conversational state across hibernation, it must persist that state itself (to disk,
which survives snapshots). Boilerhouse provides the snapshot/restore mechanism; the
container provides the state management.

### Interaction with concurrent messages

When multiple messages arrive while a previous one is still being processed:

**Sequential mode (MVP)**: Queue messages per session. Process one at a time. The
trigger adapter buffers incoming messages and sends them in order after each response.

```typescript
class SessionManager {
  private queues: Map<string, Array<PendingMessage>> = new Map();
  // ...
}
```

**Future**: Configurable queue modes (similar to OpenClaw's steer/followup/collect)
as a workload-level setting.

## Schema changes

### `packages/core/src/workload.ts`

Add optional `websocket` field to the network config schema:

```typescript
const NetworkSchema = Type.Object({
  access: Type.Union([
    Type.Literal("none"),
    Type.Literal("outbound"),
    Type.Literal("restricted"),
  ]),
  expose: Type.Optional(Type.Array(PortExposeSchema)),
  websocket: Type.Optional(Type.String({ minLength: 1 })),
  // ... existing fields
});
```

### Claim API response

Extend the claim response to include `websocket` path from the workload config.
The claim handler in `apps/api/src/routes/tenants.ts` already loads the workload
row — it just needs to extract and return the field.

## New files

```
apps/triggers/src/
  session-manager.ts           WebSocket session lifecycle
  session-manager.test.ts      unit tests with mock WS server
```

## Modified files

| File                                         | Change                                                |
|----------------------------------------------|-------------------------------------------------------|
| `packages/core/src/workload.ts`              | Add `websocket` to NetworkSchema                      |
| `apps/api/src/routes/tenants.ts`             | Include `websocket` in claim response                 |
| `apps/triggers/src/dispatcher.ts`            | Branch on `websocket` — use SessionManager or POST    |
| `apps/triggers/src/client.ts`                | Add `websocket?` to `ClaimResult`                     |
| `apps/triggers/src/adapters/slack.ts`        | Pass response callback through session                |
| `apps/triggers/src/adapters/telegram.ts`     | Pass response callback through session                |
| `apps/triggers/src/adapters/webhook.ts`      | Support streaming response from WS session            |

## Implementation order

1. Add `websocket` field to workload network schema + validation
2. Extend claim API response to include `websocket` path
3. `SessionManager` class + tests
4. Update dispatcher to use SessionManager when `websocket` is present
5. Update adapters to handle streaming/async responses from WS sessions
6. Sequential message queue for concurrent messages
7. Integration test: workload with WS endpoint + trigger sending multiple messages

## Example workload

```typescript
export default {
  name: "my-agent",
  version: "1.0.0",
  image: { ref: "my-agent:latest" },
  resources: { vcpus: 1, memory_mb: 512 },
  network: {
    access: "outbound",
    expose: [{ guest: 8080, host_range: [30000, 30099] }],
    websocket: "/ws",
  },
  entrypoint: {
    cmd: "bun",
    args: ["run", "server.ts"],
  },
};
```

Container-side (`server.ts`):

```typescript
Bun.serve({
  port: 8080,
  routes: {
    // HTTP endpoint still works for health checks, one-shot requests, etc.
    "/": (req) => new Response("ok"),
  },
  websocket: {
    message(ws, message) {
      const event = JSON.parse(message as string);
      // Process the message however the container wants.
      // AI agent: add to conversation, call LLM, respond.
      // Game server: process command, send state update.
      ws.send(JSON.stringify({ text: `Echo: ${event.text}` }));
    },
  },
  // Upgrade requests to /ws
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      server.upgrade(req);
      return;
    }
    return new Response("Not Found", { status: 404 });
  },
});
```

## Non-goals

- **Message interpretation**: Boilerhouse does not parse, store, or transform WebSocket
  messages. It is a transparent pipe.
- **Chat history**: Conversation state is the container's responsibility. Boilerhouse
  provides snapshot/restore for state persistence across hibernation.
- **Protocol enforcement**: No required message format. Containers send and receive
  whatever they want over the WebSocket.
- **Multi-port WebSocket**: One WebSocket path per workload. If a container needs
  multiple WebSocket endpoints, it can multiplex internally.
