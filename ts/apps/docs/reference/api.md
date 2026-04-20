# REST API Reference

All API endpoints are prefixed with `/api/v1/` and return JSON. The server is a thin HTTP translation of the Kubernetes API — each route maps to a `Create`, `Get`, `List`, `Update`, or `Delete` on a CRD or Pod.

## Authentication

When `BOILERHOUSE_API_KEY` is set, all routes except `/api/v1/health`, `/api/v1/stats`, and `/ws` require a Bearer token:

```
Authorization: Bearer your-api-key
```

Without the header, the API returns `401 Unauthorized`.

## System

### `GET /api/v1/health`

Liveness endpoint. Always unauthenticated.

**Response:** `{ "status": "ok" }`

### `GET /api/v1/stats`

Instance and claim counts, grouped by phase. Unauthenticated.

**Response:**

```json
{
  "instances": {
    "total": 6,
    "byPhase": { "Running": 5, "Pending": 1 }
  },
  "claims": {
    "total": 3,
    "byPhase": { "Active": 3 }
  }
}
```

---

## Workloads

Thin CRUD over `BoilerhouseWorkload` CRs.

### `POST /api/v1/workloads`

Create a new workload.

**Body:**

```json
{
  "name": "my-agent",
  "spec": {
    "version": "1.0.0",
    "image": { "ref": "my-registry/my-agent:latest" },
    "resources": { "vcpus": 2, "memoryMb": 2048, "diskGb": 10 },
    "network": { "access": "none" },
    "idle": { "timeoutSeconds": 300, "action": "hibernate" }
  }
}
```

See [Workload Schema](./workload-schema) for the full spec.

**Response (201):**

```json
{
  "name": "my-agent",
  "spec": { /* ... */ },
  "status": { "phase": "Creating" },
  "createdAt": "2026-04-20T10:00:00Z"
}
```

### `GET /api/v1/workloads`

List all workloads.

### `GET /api/v1/workloads/{name}`

Get a workload by name.

### `PUT /api/v1/workloads/{name}`

Replace a workload's spec.

**Body:** Same shape as POST.

### `DELETE /api/v1/workloads/{name}`

Delete a workload.

**Response:** `{ "status": "deleted" }`

### `GET /api/v1/workloads/{name}/snapshots`

List snapshot archives for a workload.

**Response:**

```json
[
  {
    "tenantId": "alice",
    "workloadRef": "my-agent",
    "path": "/snapshots/alice/my-agent.tar.gz"
  }
]
```

---

## Snapshots

### `GET /api/v1/snapshots`

List all snapshots across all workloads. Same shape as `/workloads/{name}/snapshots`.

---

## Tenants

### `POST /api/v1/tenants/{id}/claim`

Claim an instance for a tenant. Creates (or revives) a `BoilerhouseClaim` and polls until it becomes `Active` or `Error` (30 second timeout).

**Body:**

```json
{
  "workload": "my-agent",
  "resume": true
}
```

`workload` can also be written as `workloadRef`.

**Response (201):**

```json
{
  "tenantId": "alice",
  "phase": "Active",
  "instanceId": "inst-alice-my-agent-a1b2c3",
  "endpoint": { "host": "10.244.0.12", "port": 8080 },
  "source": "pool",
  "claimedAt": "2026-04-20T10:30:00Z"
}
```

`source` is one of: `existing`, `pool`, `pool+data`, `cold`, `cold+data`.

### `POST /api/v1/tenants/{id}/release`

Release a tenant's claim for a workload. Deletes the `BoilerhouseClaim` CR, which triggers overlay extraction and Pod cleanup in the operator.

**Body:**

```json
{ "workload": "my-agent" }
```

**Response:** `{ "status": "released", "tenantId": "alice" }`

### `GET /api/v1/tenants/{id}`

Get tenant state — all claims owned by this tenant.

**Response:**

```json
{
  "tenantId": "alice",
  "claims": [
    {
      "tenantId": "alice",
      "phase": "Active",
      "instanceId": "inst-alice-my-agent-a1b2c3",
      "endpoint": { "host": "10.244.0.12", "port": 8080 },
      "source": "pool",
      "claimedAt": "2026-04-20T10:30:00Z"
    }
  ]
}
```

### `GET /api/v1/tenants`

List all tenants (derived from `BoilerhouseClaim` CRs).

---

## Instances

Instances are Pods labeled `boilerhouse.dev/managed=true`.

### `GET /api/v1/instances`

List all managed Pods.

**Response:**

```json
[
  {
    "name": "inst-alice-my-agent-a1b2c3",
    "phase": "Running",
    "tenantId": "alice",
    "workloadRef": "my-agent",
    "ip": "10.244.0.12",
    "labels": { /* all pod labels */ },
    "createdAt": "2026-04-20T10:29:55Z",
    "lastActivity": "2026-04-20T10:35:00Z",
    "claimedAt": "2026-04-20T10:30:00Z"
  }
]
```

### `GET /api/v1/instances/{id}`

Get a single instance.

### `GET /api/v1/instances/{id}/logs`

Get container logs. Returns plain text (`Content-Type: text/plain`).

**Query Parameters:**
- `tail` — number of lines to return

The API shells out to `kubectl logs`, so `kubectl` must be on PATH wherever the API runs.

### `POST /api/v1/instances/{id}/exec`

Execute a command inside a running Pod. Shells out to `kubectl exec`.

**Body:**

```json
{ "command": ["ls", "-la", "/workspace"] }
```

**Response:**

```json
{
  "stdout": "total 8\n...",
  "stderr": "",
  "exitCode": 0
}
```

### `POST /api/v1/instances/{id}/destroy`

Force-delete the Pod. Does not extract overlays; use tenant release for graceful hibernation.

**Response:** `{ "status": "destroyed", "instance": "..." }`

---

## Triggers

Thin CRUD over `BoilerhouseTrigger` CRs.

### `POST /api/v1/triggers`

**Body:**

```json
{
  "name": "my-webhook",
  "spec": {
    "type": "webhook",
    "workloadRef": "my-agent",
    "tenant": { "from": "userId" },
    "config": { "path": "/hooks/my-agent" }
  }
}
```

### `GET /api/v1/triggers`

List triggers.

### `GET /api/v1/triggers/{id}`

Get a trigger.

### `DELETE /api/v1/triggers/{id}`

Delete a trigger.

---

## Debug

### `GET /api/v1/debug/resources`

Dumps every resource in the `boilerhouse` namespace (Pods, Services, ConfigMaps, PVCs, NetworkPolicies, plus the four Boilerhouse CRDs). Useful for troubleshooting.

---

## WebSocket

### `GET /ws`

Streams Pod and Claim change events to the client. See [WebSocket Events](./websocket).

The `/ws` endpoint is outside the auth middleware — the dashboard proxy doesn't forward the API key. Protect it at the edge (reverse proxy) if needed.

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
| `500` | Internal error (usually a Kubernetes API error propagated upstream) |
