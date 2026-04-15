# REST API

Complete reference for the Boilerhouse HTTP API. All endpoints are prefixed with `/api/v1` unless otherwise noted.

## Authentication

When `BOILERHOUSE_API_KEY` is set, all requests except health checks must include the API key:

```
Authorization: Bearer <key>
```

WebSocket connections authenticate via query parameter:

```
ws://localhost:3000/ws?token=<key>
```

Unauthenticated requests receive `401 Unauthorized`.

## Endpoints

### System

#### `GET /api/v1/health`

Health check. Always accessible without authentication.

**Response (200):**
```json
{ "status": "ok" }
```

#### `GET /api/v1/stats`

System statistics.

**Response (200):**
```json
{
  "instances": { "active": 5, "starting": 1 },
  "snapshots": 12,
  "nodes": 1
}
```

---

### Workloads

#### `POST /api/v1/workloads`

Register a new workload.

**Request body:** Full workload config object. See [Workload Schema](./workload-schema.md).

**Response (201):**
```json
{
  "workloadId": "wkl_abc123",
  "name": "my-agent",
  "version": "0.1.0",
  "status": "creating",
  "createdAt": "2025-01-15T10:30:00Z",
  "updatedAt": "2025-01-15T10:30:00Z"
}
```

**Errors:** `400` invalid config, `409` name already exists.

#### `GET /api/v1/workloads`

List all workloads.

**Response (200):**
```json
[
  {
    "workloadId": "wkl_abc123",
    "name": "my-agent",
    "version": "0.1.0",
    "status": "ready",
    "statusDetail": null,
    "idleTimeoutSeconds": 300,
    "createdAt": "2025-01-15T10:30:00Z",
    "updatedAt": "2025-01-15T10:30:00Z"
  }
]
```

#### `GET /api/v1/workloads/:name`

Get a workload by name.

**Response (200):**
```json
{
  "workloadId": "wkl_abc123",
  "name": "my-agent",
  "version": "0.1.0",
  "status": "ready",
  "statusDetail": null,
  "config": { },
  "instanceCount": 3,
  "createdAt": "2025-01-15T10:30:00Z",
  "updatedAt": "2025-01-15T10:30:00Z"
}
```

**Errors:** `404` workload not found.

#### `PUT /api/v1/workloads/:name`

Update a workload's configuration.

**Request body:** Full workload config object.

**Response (200):**
```json
{ "changed": true }
```

**Errors:** `400` invalid config, `404` workload not found.

#### `DELETE /api/v1/workloads/:name`

Delete a workload. Fails if active instances exist.

**Response (200):**
```json
{ "deleted": true }
```

**Errors:** `404` workload not found, `409` has active instances or status is `"creating"`.

#### `GET /api/v1/workloads/:name/snapshots`

List snapshots for a workload.

**Response (200):** Array of snapshot objects.

**Errors:** `404` workload not found.

#### `GET /api/v1/workloads/:name/logs`

Get build logs for a workload.

**Response (200):** Array of log line strings.

**Errors:** `404` workload not found.

---

### Instances

#### `GET /api/v1/instances`

List instances. Supports optional status filter.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status (e.g., `active`, `starting`, `hibernated`) |

**Response (200):**
```json
[
  {
    "instanceId": "ins_xyz789",
    "workloadId": "wkl_abc123",
    "nodeId": "node_01",
    "tenantId": "tenant-a",
    "status": "active",
    "statusDetail": null,
    "hasSidecar": true,
    "lastActivity": "2025-01-15T10:35:00Z",
    "claimedAt": "2025-01-15T10:30:00Z",
    "createdAt": "2025-01-15T10:28:00Z"
  }
]
```

#### `GET /api/v1/instances/:id`

Get instance details.

**Response (200):**
```json
{
  "instanceId": "ins_xyz789",
  "workloadId": "wkl_abc123",
  "nodeId": "node_01",
  "tenantId": "tenant-a",
  "status": "active",
  "runtimeMeta": {},
  "lastActivity": "2025-01-15T10:35:00Z",
  "claimedAt": "2025-01-15T10:30:00Z",
  "createdAt": "2025-01-15T10:28:00Z"
}
```

**Errors:** `404` instance not found.

#### `GET /api/v1/instances/:id/endpoint`

Get the network endpoint for an instance.

**Response (200):**
```json
{
  "instanceId": "ins_xyz789",
  "status": "active",
  "endpoint": {
    "host": "127.0.0.1",
    "ports": { "8080": 32456 }
  }
}
```

**Errors:** `404` instance not found, `409` instance not active or not claimed.

#### `GET /api/v1/instances/:id/logs`

Get container logs for an instance.

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tail` | `200` | Number of lines to return (1--5000) |

**Response (200):**
```json
{
  "instanceId": "ins_xyz789",
  "logs": ["2025-01-15T10:30:00Z Starting server...", "..."]
}
```

**Errors:** `404` instance not found, `409` invalid state, `501` runtime does not support logs.

#### `POST /api/v1/instances/:id/exec`

Execute a command inside a running instance.

**Request body:**
```json
{ "command": ["ls", "-la"] }
```

**Response (200):**
```json
{
  "exitCode": 0,
  "stdout": "total 32\ndrwxr-xr-x ...",
  "stderr": ""
}
```

**Errors:** `404` instance not found, `409` instance not active.

#### `POST /api/v1/instances/:id/destroy`

Destroy an instance immediately.

**Response (200):**
```json
{
  "instanceId": "ins_xyz789",
  "status": "destroyed"
}
```

**Errors:** `404` instance not found, `409` invalid state transition.

#### `POST /api/v1/instances/:id/hibernate`

Hibernate an instance, snapshotting its filesystem state.

**Response (200):**
```json
{
  "instanceId": "ins_xyz789",
  "status": "hibernating"
}
```

**Errors:** `404` instance not found, `409` invalid state transition.

---

### Tenants

#### `POST /api/v1/tenants/:id/claim`

Claim an instance for a tenant. If the tenant has prior state (snapshot, overlay), it is restored. Otherwise a fresh instance is assigned from the pool.

**Path parameters:**

| Parameter | Pattern | Description |
|-----------|---------|-------------|
| `id` | `^[a-zA-Z0-9._@:-]{1,256}$` | Tenant identifier |

**Request body:**
```json
{ "workload": "my-agent" }
```

**Response (200):**
```json
{
  "tenantId": "user@example.com",
  "instanceId": "ins_xyz789",
  "endpoint": {
    "host": "127.0.0.1",
    "ports": { "8080": 32456 }
  },
  "source": "pool",
  "latencyMs": 342,
  "websocket": "/ws"
}
```

The `source` field indicates how the instance was provisioned: `"pool"` (from warm pool), `"pool+data"` (from pool with tenant overlay restored), `"cold"` (fresh boot), `"cold+data"` (fresh boot with overlay restored), or `"existing"` (already running for this tenant).

**Errors:** `404` workload not found, `409` invalid state, `503` at capacity (includes `Retry-After: 5` header).

#### `POST /api/v1/tenants/:id/release`

Release a tenant's claim on an instance. The instance will be hibernated or destroyed based on the workload's idle action.

**Request body:**
```json
{ "workload": "my-agent" }
```

**Response (200):**
```json
{ "released": true }
```

**Errors:** `404` tenant or workload not found, `409` invalid state.

#### `GET /api/v1/tenants/:id`

Get tenant information across all workloads.

**Response (200):**
```json
[
  {
    "tenantId": "user@example.com",
    "workloadId": "wkl_abc123",
    "instanceId": "ins_xyz789",
    "lastSnapshotId": "snap_001",
    "dataOverlayRef": "overlay_ref",
    "lastActivity": "2025-01-15T10:35:00Z",
    "createdAt": "2025-01-15T10:30:00Z",
    "instance": { },
    "snapshots": []
  }
]
```

**Errors:** `404` tenant not found.

#### `GET /api/v1/tenants`

List all tenants.

**Response (200):**
```json
[
  {
    "tenantId": "user@example.com",
    "workloadId": "wkl_abc123",
    "instanceId": "ins_xyz789",
    "lastActivity": "2025-01-15T10:35:00Z",
    "createdAt": "2025-01-15T10:30:00Z"
  }
]
```

---

### Secrets

Secrets are scoped to a tenant and injected into instances at claim time via the workload's `network.credentials` configuration. See [Workload Schema](./workload-schema.md) for credential injection syntax.

#### `PUT /api/v1/tenants/:id/secrets/:name`

Set a tenant secret. Creates or overwrites the secret.

**Path parameters:**

| Parameter | Pattern | Description |
|-----------|---------|-------------|
| `name` | `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` | Secret name |

**Request body:**
```json
{ "value": "sk-abc123..." }
```

**Response (201):**
```json
{ "stored": true }
```

**Errors:** `400` invalid secret name.

#### `GET /api/v1/tenants/:id/secrets`

List secret names for a tenant. Values are never returned.

**Response (200):**
```json
{ "secrets": ["API_KEY", "DB_PASSWORD"] }
```

**Errors:** `404` tenant not found.

#### `DELETE /api/v1/tenants/:id/secrets/:name`

Delete a tenant secret.

**Response (200):**
```json
{ "deleted": true }
```

---

### Triggers

Triggers automate instance claims in response to external events. See [Triggers](../guide/triggers.md) for concepts and usage patterns.

#### `GET /api/v1/triggers`

List all triggers.

**Response (200):** Array of trigger objects.

#### `GET /api/v1/triggers/:id`

Get a trigger by ID.

**Response (200):** Full trigger object.

**Errors:** `404` trigger not found.

#### `POST /api/v1/triggers`

Create a trigger.

**Request body:**
```json
{
  "name": "my-webhook",
  "type": "webhook",
  "workload": "my-agent",
  "tenant": { "static": "system" },
  "config": { "path": "/hooks/deploy" }
}
```

**Response (201):** Trigger object with `id`, `createdAt`, `updatedAt`.

**Errors:** `409` name already exists.

#### `PUT /api/v1/triggers/:id`

Update a trigger. Same body format as POST.

**Response (200):** Updated trigger object.

**Errors:** `404` trigger not found.

#### `DELETE /api/v1/triggers/:id`

Delete a trigger.

**Response (200):**
```json
{ "ok": true }
```

**Errors:** `404` trigger not found.

#### `POST /api/v1/triggers/:id/enable`

Enable a disabled trigger.

**Response (200):** Trigger object with `enabled: true`.

#### `POST /api/v1/triggers/:id/disable`

Disable a trigger.

**Response (200):** Trigger object with `enabled: false`.

#### `POST /api/v1/triggers/:id/test`

Test a trigger by executing it with a synthetic payload.

**Request body:**
```json
{
  "tenantId": "test-user",
  "payload": { "text": "hello" }
}
```

**Response (200):**
```json
{
  "claim": {
    "tenantId": "test-user",
    "instanceId": "ins_xyz789",
    "endpoint": { "host": "127.0.0.1", "ports": { "8080": 32456 } },
    "source": "pool",
    "latencyMs": 500
  },
  "response": {
    "status": 200,
    "body": "OK"
  }
}
```

**Errors:** `404` trigger not found, `409` invalid state, `503` at capacity.

---

### Nodes

#### `GET /api/v1/nodes`

List all nodes.

**Response (200):**
```json
[
  {
    "nodeId": "node_01",
    "runtimeType": "docker",
    "capacity": 100,
    "status": "ready",
    "statusDetail": null,
    "lastHeartbeat": "2025-01-15T10:35:00Z",
    "createdAt": "2025-01-15T08:00:00Z"
  }
]
```

#### `GET /api/v1/nodes/:id`

Get node details.

**Response (200):**
```json
{
  "nodeId": "node_01",
  "runtimeType": "docker",
  "capacity": 100,
  "status": "ready",
  "instanceCount": 12,
  "lastHeartbeat": "2025-01-15T10:35:00Z",
  "createdAt": "2025-01-15T08:00:00Z"
}
```

**Errors:** `404` node not found.

---

### Activity

#### `GET /api/v1/audit`

Query the audit log.

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | `200` | Maximum number of entries to return |
| `instanceId` | -- | Filter by instance ID |
| `tenantId` | -- | Filter by tenant ID |
| `workloadId` | -- | Filter by workload ID |
| `event` | -- | Filter by event type |

**Response (200):**
```json
[
  {
    "id": "aud_001",
    "event": "instance.claimed",
    "instanceId": "ins_xyz789",
    "tenantId": "user@example.com",
    "workloadId": "wkl_abc123",
    "nodeId": "node_01",
    "metadata": {},
    "createdAt": "2025-01-15T10:30:00Z"
  }
]
```

---

### WebSocket

#### `WS /ws`

Real-time event stream. Delivers domain events as they occur (instance state changes, claims, releases, health transitions, etc.).

**Authentication:** Use the `token` query parameter:
```
ws://localhost:3000/ws?token=<api-key>
```

**Message format:** Each message is a JSON-encoded event:
```json
{
  "type": "instance.started",
  "instanceId": "ins_xyz789",
  "workloadId": "wkl_abc123",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

**Direction:** Server to client only. Client messages are ignored.

---

## Error Responses

All errors return a JSON body:

```json
{ "error": "Human-readable error message" }
```

### Status Codes

| Code | Meaning |
|------|---------|
| `400` | Invalid request body or parameters |
| `401` | Missing or invalid API key |
| `404` | Resource not found |
| `409` | Invalid state transition or resource conflict |
| `422` | Validation failure |
| `429` | Rate limit exceeded (includes `Retry-After` header) |
| `501` | Operation not supported by the current runtime |
| `503` | At capacity or service not ready (includes `Retry-After` header) |
