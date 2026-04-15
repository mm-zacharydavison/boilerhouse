# Observability

Boilerhouse provides structured logging, Prometheus metrics, and OpenTelemetry distributed tracing.

## Logging

Boilerhouse uses [Pino](https://github.com/pinojs/pino) for structured JSON logging.

### Log Levels

```bash
export LOG_LEVEL=info  # trace, debug, info, warn, error, fatal
```

### Log Format

Logs include contextual fields:

```json
{
  "level": 30,
  "time": 1705312200000,
  "msg": "Tenant claimed",
  "tenantId": "alice",
  "instanceId": "inst_abc123",
  "workloadId": "wkl_xyz",
  "source": "pool",
  "latencyMs": 450
}
```

In development, Pino pretty-prints logs. In production (when `NODE_ENV=production`), logs are emitted as JSON for log aggregation.

### Bootstrap Logs

Workload startup logs are captured separately and available via:

```bash
curl http://localhost:3000/api/v1/workloads/my-agent/logs
```

These are useful for debugging workload image build or startup failures.

## Metrics

Boilerhouse exposes Prometheus metrics on a dedicated port.

### Configuration

```bash
export METRICS_PORT=9464     # default
export METRICS_HOST=127.0.0.1  # default
```

Scrape metrics at `http://localhost:9464/metrics`.

### Available Metrics

#### Tenant Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.tenant.claim.duration` | Histogram | workload, source | Time to complete a claim |
| `boilerhouse.tenant.claims` | Counter | workload, source | Total claims |
| `boilerhouse.tenant.releases` | Counter | workload | Total releases |
| `boilerhouse.tenants.active` | Gauge | workload | Currently active tenants |

#### Instance Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.instances` | Gauge | status | Instance count by status |
| `boilerhouse.instance.transitions` | Counter | from, to, workload | State transitions |
| `boilerhouse.instance.transition.duration` | Histogram | workload | Time from starting to ready |
| `boilerhouse.idle.timeouts` | Counter | workload | Idle timeout events |

#### Pool Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.pool.depth` | Gauge | workload | Ready instances in pool |
| `boilerhouse.pool.cold_start.duration` | Histogram | workload | Time to create a pool instance |

#### Snapshot Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.snapshot.creates` | Counter | workload | Snapshot creations |
| `boilerhouse.snapshot.create.duration` | Histogram | workload | Snapshot creation time |
| `boilerhouse.snapshot.disk.total` | Gauge | workload, type | Total snapshot storage bytes |
| `boilerhouse.snapshot.count` | Gauge | workload, type | Number of snapshots |

#### Health Check Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.healthcheck.duration` | Histogram | workload | Time until healthy |
| `boilerhouse.healthcheck.failures` | Counter | workload | Failed health checks |

#### Trigger Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.trigger.dispatches` | Counter | type, outcome | Trigger dispatch events |
| `boilerhouse.trigger.dispatch.duration` | Histogram | type | Dispatch processing time |

#### Capacity Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.node.capacity.max` | Gauge | node | Maximum instances per node |
| `boilerhouse.node.capacity.used` | Gauge | node | Current instances per node |

#### System Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.system.cpus` | Gauge | — | Logical CPU count |
| `boilerhouse.system.mem.capacity` | Gauge | — | Total memory bytes |
| `boilerhouse.system.mem.available` | Gauge | — | Available memory bytes |
| `boilerhouse.system.cpu.usage` | Gauge | — | CPU usage (0.0-1.0) |
| `boilerhouse.container.cpu` | Gauge | instance | Per-container CPU |
| `boilerhouse.container.mem` | Gauge | instance | Per-container memory |

#### HTTP Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.http.request.duration` | Histogram | method, route, status | HTTP request latency |
| `boilerhouse.http.requests` | Counter | method, route, status | HTTP request count |

#### WebSocket Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.ws.connections` | UpDownCounter | — | Active WebSocket connections |

## Tracing

Boilerhouse supports OpenTelemetry distributed tracing via OTLP export.

### Configuration

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Traces are exported using the OpenTelemetry Protocol (OTLP) over HTTP.

### Instrumented Operations

Spans are created for:

| Span Name | Description |
|-----------|-------------|
| `HTTP {method} {route}` | Every HTTP request |
| `tenant.claim` | Tenant claim operation (includes source, instance ID) |
| `tenant.release` | Tenant release operation |

Span attributes include `tenant.id`, `workload.id`, `instance.id`, `claim.source`, and error details when applicable.

### Route Normalization

HTTP routes are normalized in traces to avoid high cardinality:
- UUIDs are replaced with `:id`
- Numeric path segments are replaced with `:id`
- Example: `/api/v1/instances/abc-123-def/logs` becomes `/api/v1/instances/:id/logs`

## Activity Log

Boilerhouse maintains a persistent audit trail of lifecycle events in the database:

```bash
curl http://localhost:3000/api/v1/audit?limit=50
```

```json
[
  {
    "id": 42,
    "event": "tenant.claimed",
    "instanceId": "inst_abc123",
    "workloadId": "wkl_xyz",
    "tenantId": "alice",
    "metadata": { "source": "pool" },
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
]
```

Filter by instance, tenant, workload, or event type:

```bash
curl "http://localhost:3000/api/v1/audit?tenantId=alice&event=tenant.claimed"
```

## Real-time Events

Connect via WebSocket to receive domain events in real time:

```bash
wscat -c "ws://localhost:3000/ws?token=YOUR_API_KEY"
```

Events include state transitions, claims, releases, idle timeouts, trigger dispatches, and health check results.

## Observability Stack

The repository includes a Docker Compose file for a local observability stack:

```bash
docker compose up -d prometheus grafana tempo
```

| Service | URL | Purpose |
|---------|-----|---------|
| Prometheus | `http://localhost:9090` | Metrics collection and querying |
| Grafana | `http://localhost:3001` | Dashboards and visualization |
| Tempo | `http://localhost:3200` | Distributed trace storage |

Prometheus is pre-configured to scrape `http://localhost:9464/metrics`. Grafana has Prometheus and Tempo as pre-configured data sources.
