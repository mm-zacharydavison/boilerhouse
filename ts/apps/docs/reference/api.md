# REST API Reference

All API endpoints are prefixed with `/api/v1/` and return JSON.

## Authentication

When `BOILERHOUSE_API_KEY` is set, include a Bearer token with every request:

```
Authorization: Bearer your-api-key
```

Without the header, the API returns `401 Unauthorized`.

## System

### `GET /api/v1/health`

Health check endpoint.

**Response:**

```json
{ "status": "ok" }
```

### `GET /api/v1/stats`

System statistics.

**Response:**

```json
{
  "instances": {
    "active": 5,
    "starting": 1,
    "hibernated": 12,
    "destroyed": 30
  },
  "snapshots": 15,
  "nodes": 1
}
```

---

## Workloads

### `POST /api/v1/workloads`

Register a new workload.

**Body:** Workload definition object (see [Workload Schema](./workload-schema)).

**Response (201):**

```json
{
  "workloadId": "wkl_abc123",
  "name": "my-agent",
  "version": "1.0.0",
  "status": "creating"
}
```

**Errors:**
- `400` — invalid workload definition
- `409` — workload with same name+version already exists

### `PUT /api/v1/workloads/:name`

Update an existing workload's configuration.

**Body:** Workload definition object.

**Response:**

```json
{ "changed": true }
```

Returns `{ "changed": false }` if the config is identical. Triggers pool re-priming if config changed.

**Errors:**
- `400` — invalid workload definition
- `404` — workload not found

### `GET /api/v1/workloads`

List all registered workloads.

**Response:**

```json
[
  {
    "workloadId": "wkl_abc123",
    "name": "my-agent",
    "version": "1.0.0",
    "status": "ready",
    "statusDetail": null,
    "idleTimeoutSeconds": 300,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T10:00:30.000Z"
  }
]
```

### `GET /api/v1/workloads/:name`

Get detailed workload information.

**Response:**

```json
{
  "workloadId": "wkl_abc123",
  "name": "my-agent",
  "version": "1.0.0",
  "status": "ready",
  "config": { /* full workload config */ },
  "instanceCount": 5,
  "createdAt": "2024-01-15T10:00:00.000Z",
  "updatedAt": "2024-01-15T10:00:30.000Z"
}
```

### `GET /api/v1/workloads/:name/snapshots`

List snapshots for a workload.

**Response:**

```json
[
  {
    "snapshotId": "snap_xyz",
    "type": "tenant",
    "status": "ready",
    "instanceId": "inst_abc123",
    "tenantId": "alice",
    "workloadId": "wkl_abc123",
    "sizeBytes": 1048576,
    "createdAt": "2024-01-15T11:00:00.000Z"
  }
]
```

### `GET /api/v1/workloads/:name/logs`

Get workload build/bootstrap logs.

**Response:** Array of log line strings.

### `DELETE /api/v1/workloads/:name`

Delete a workload. Fails if active instances exist.

**Response:**

```json
{ "deleted": true }
```

**Errors:**
- `404` — workload not found
- `409` — workload is still creating, or has active instances

---

## Instances

### `GET /api/v1/instances`

List instances. Optionally filter by status.

**Query Parameters:**
- `status` — filter by instance status (`starting`, `active`, `hibernated`, `destroying`, `destroyed`)

**Response:**

```json
[
  {
    "instanceId": "inst_abc123",
    "workloadId": "wkl_xyz",
    "nodeId": "node_1",
    "tenantId": "alice",
    "status": "active",
    "statusDetail": null,
    "hasSidecar": true,
    "lastActivity": "2024-01-15T10:35:00.000Z",
    "claimedAt": "2024-01-15T10:30:00.000Z",
    "createdAt": "2024-01-15T10:29:55.000Z"
  }
]
```

### `GET /api/v1/instances/:id`

Get instance details.

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz",
  "nodeId": "node_1",
  "tenantId": "alice",
  "status": "active",
  "runtimeMeta": { "containerId": "abc...", "hasSidecar": true },
  "lastActivity": "2024-01-15T10:35:00.000Z",
  "claimedAt": "2024-01-15T10:30:00.000Z",
  "createdAt": "2024-01-15T10:29:55.000Z"
}
```

### `GET /api/v1/instances/:id/endpoint`

Get network endpoint for a running instance.

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "status": "active",
  "endpoint": { "host": "127.0.0.1", "ports": [30042] }
}
```

**Errors:**
- `404` — instance not found
- `409` — instance is hibernated, destroyed, or a pool instance

### `GET /api/v1/instances/:id/logs`

Get container logs.

**Query Parameters:**
- `tail` — number of lines (default: 200, max: 5000)

**Response:**

```json
{
  "instanceId": "inst_abc123",
  "logs": "2024-01-15T10:30:00Z Starting server...\n..."
}
```

**Errors:**
- `409` — instance is hibernated or destroyed
- `501` — runtime does not support log retrieval

### `POST /api/v1/instances/:id/exec`

Execute a command inside a running instance.

**Body:**

```json
{
  "command": ["ls", "-la", "/workspace"]
}
```

**Response:**

```json
{
  "exitCode": 0,
  "stdout": "total 8\n...",
  "stderr": ""
}
```

**Errors:**
- `409` — instance is not active

### `POST /api/v1/instances/:id/destroy`

Force-destroy an instance.

**Response:**

```json
{ "instanceId": "inst_abc123", "status": "destroyed" }
```

### `POST /api/v1/instances/:id/hibernate`

Hibernate an instance (extract overlay, then destroy).

**Response:**

```json
{ "instanceId": "inst_abc123", "status": "hibernated" }
```

---

## Tenants

### `POST /api/v1/tenants/:id/claim`

Claim an instance for a tenant. The tenant ID must match `[a-zA-Z0-9._@:-]{1,256}`.

**Body:**

```json
{ "workload": "my-agent" }
```

**Response:**

```json
{
  "tenantId": "alice",
  "instanceId": "inst_abc123",
  "endpoint": { "host": "127.0.0.1", "ports": [30042] },
  "source": "pool",
  "latencyMs": 450,
  "websocket": "/ws"
}
```

The `websocket` field is only present if the workload defines a `network.websocket` path.

**Errors:**
- `404` — workload not found
- `409` — invalid state transition
- `503` — workload not ready, or node at capacity (includes `Retry-After` header)

### `POST /api/v1/tenants/:id/release`

Release a tenant's claim on a workload.

**Body:**

```json
{ "workload": "my-agent" }
```

**Response:**

```json
{ "released": true }
```

### `GET /api/v1/tenants/:id`

Get tenant state across all workloads.

**Response:**

```json
[
  {
    "tenantId": "alice",
    "workloadId": "wkl_abc",
    "instanceId": "inst_123",
    "lastSnapshotId": "snap_456",
    "dataOverlayRef": "tenants/alice/wkl_abc/overlay.tar.gz",
    "lastActivity": "2024-01-15T10:35:00.000Z",
    "createdAt": "2024-01-15T10:00:00.000Z",
    "instance": {
      "instanceId": "inst_123",
      "status": "active",
      "createdAt": "2024-01-15T10:30:00.000Z"
    },
    "snapshots": [
      {
        "snapshotId": "snap_456",
        "type": "tenant",
        "createdAt": "2024-01-15T09:00:00.000Z"
      }
    ]
  }
]
```

### `GET /api/v1/tenants`

List all tenants.

**Response:**

```json
[
  {
    "tenantId": "alice",
    "workloadId": "wkl_abc",
    "instanceId": "inst_123",
    "lastActivity": "2024-01-15T10:35:00.000Z",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
]
```

---

## Secrets

### `PUT /api/v1/tenants/:id/secrets/:name`

Store or update a per-tenant secret. Secret names must match `[a-zA-Z0-9][a-zA-Z0-9._-]*`.

**Body:**

```json
{ "value": "sk-ant-..." }
```

**Response (201):**

```json
{ "stored": true }
```

### `GET /api/v1/tenants/:id/secrets`

List secret names for a tenant (values are not returned).

**Response:**

```json
{
  "secrets": ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]
}
```

### `DELETE /api/v1/tenants/:id/secrets/:name`

Delete a per-tenant secret.

**Response:**

```json
{ "deleted": true }
```

---

## Triggers

### `GET /api/v1/triggers`

List all triggers.

### `GET /api/v1/triggers/:id`

Get trigger details.

### `POST /api/v1/triggers`

Create a trigger.

**Body:**

```json
{
  "name": "my-webhook",
  "type": "webhook",
  "tenant": { "fromField": "userId" },
  "workload": "my-agent",
  "config": { "path": "/hooks/my-agent" },
  "driver": "@boilerhouse/driver-claude-code",
  "driverOptions": {}
}
```

**Response (201):** The created trigger object.

### `PUT /api/v1/triggers/:id`

Update a trigger. Body is the same schema as POST.

### `DELETE /api/v1/triggers/:id`

Delete a trigger.

**Response:**

```json
{ "ok": true }
```

### `POST /api/v1/triggers/:id/enable`

Enable a disabled trigger.

### `POST /api/v1/triggers/:id/disable`

Disable a trigger.

### `POST /api/v1/triggers/:id/test`

Test a trigger with a sample payload.

**Body:**

```json
{
  "tenantId": "test-user",
  "payload": { "message": "hello" }
}
```

**Response:**

```json
{
  "claim": {
    "tenantId": "test-user",
    "instanceId": "inst_abc123",
    "endpoint": { "host": "127.0.0.1", "port": 30042 },
    "source": "pool",
    "latencyMs": 450
  },
  "response": {
    "status": 200,
    "body": { "reply": "Hello!" }
  }
}
```

---

## Nodes

### `GET /api/v1/nodes`

List all registered nodes.

**Response:**

```json
[
  {
    "nodeId": "node_abc",
    "runtimeType": "docker",
    "capacity": { "maxInstances": 100 },
    "status": "active",
    "lastHeartbeat": "2024-01-15T10:35:00.000Z",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
]
```

### `GET /api/v1/nodes/:id`

Get node details including instance count.

---

## Activity Log

### `GET /api/v1/audit`

Query the activity audit log.

**Query Parameters:**
- `limit` — max entries (default: 200, max: 500)
- `instanceId` — filter by instance
- `tenantId` — filter by tenant
- `workloadId` — filter by workload
- `event` — filter by event type

**Response:**

```json
[
  {
    "id": 42,
    "event": "tenant.claimed",
    "instanceId": "inst_abc123",
    "workloadId": "wkl_xyz",
    "nodeId": "node_1",
    "tenantId": "alice",
    "metadata": { "source": "pool" },
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
]
```

---

## Error Responses

All errors follow a consistent format:

```json
{ "error": "Human-readable error message" }
```

Common status codes:

| Status | Meaning |
|--------|---------|
| `400` | Bad request (invalid input) |
| `401` | Unauthorized (missing or invalid API key) |
| `404` | Resource not found |
| `409` | Conflict (invalid state transition, duplicate resource) |
| `501` | Not implemented (runtime doesn't support the operation) |
| `503` | Service unavailable (workload not ready, node at capacity) |
