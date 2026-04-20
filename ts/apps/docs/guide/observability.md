# Observability

All three Boilerhouse binaries (operator, API, trigger gateway) emit structured logs, OpenTelemetry metrics, and OpenTelemetry traces through the shared `go/internal/o11y` package.

## Logging

Boilerhouse uses Go's standard `log/slog` for structured JSON logging.

### Log Levels

```bash
export LOG_LEVEL=info  # debug, info, warn, error
```

### Log Format

Logs are JSON with contextual fields:

```json
{
  "time": "2026-04-20T10:30:00Z",
  "level": "INFO",
  "msg": "tenant claimed",
  "tenantId": "alice",
  "instanceId": "inst-alice-my-agent-a1b2c3",
  "workloadRef": "my-agent",
  "source": "pool"
}
```

The controller-runtime operator uses `zap` in dev mode for human-readable logs during development and JSON in production.

## Metrics

Each binary exposes Prometheus metrics on a dedicated port.

### Configuration

```bash
# Operator
export METRICS_PORT=9464  # default

# API / trigger
# metrics served on the same port as the /metrics route
```

Scrape metrics at `http://<binary>:<port>/metrics`.

### Available Metrics

Metrics are grouped into categories. The operator emits most of them; the API and trigger gateway emit the HTTP and dispatch metrics.

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
| `boilerhouse.instances` | Gauge | phase | Pod count by phase |
| `boilerhouse.instance.transitions` | Counter | from, to, workload | State transitions |
| `boilerhouse.instance.transition.duration` | Histogram | workload | Time from Pending to Running |
| `boilerhouse.idle.timeouts` | Counter | workload | Idle timeout events |

#### Pool Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.pool.depth` | Gauge | workload | Ready Pods in pool |
| `boilerhouse.pool.cold_start.duration` | Histogram | workload | Time to warm a new pool Pod |

#### Snapshot Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.snapshot.creates` | Counter | workload | Snapshot creations |
| `boilerhouse.snapshot.create.duration` | Histogram | workload | Snapshot creation time |

#### Trigger Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `boilerhouse.trigger.dispatches` | Counter | type, outcome | Trigger dispatch events |
| `boilerhouse.trigger.dispatch.duration` | Histogram | type | Dispatch processing time |

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

Boilerhouse exports OpenTelemetry traces via OTLP.

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
| `reconcile.<crd>` | Controller reconcile invocations |

Span attributes include `tenant.id`, `workload.id`, `instance.id`, `claim.source`, and error details when applicable.

### Route Normalization

HTTP routes are normalized in traces to avoid high cardinality:
- Path parameters (`{id}`, `{name}`) are kept as templates, e.g. `/api/v1/instances/{id}/logs`

## Real-time Events

The API's WebSocket endpoint streams Pod and Claim changes in real time, consumed primarily by the dashboard:

```bash
wscat -c "ws://localhost:3000/ws"
```

See [WebSocket Events](../reference/websocket) for the event schema.

## Kubernetes-Native Views

Because all state lives in the Kubernetes API, you can observe Boilerhouse with standard kubectl:

```bash
# Watch claim phase transitions live
kubectl get boilerhouseclaims -n boilerhouse -w

# Watch pool fill progress
kubectl get boilerhousepools -n boilerhouse -w

# See raw events (useful for failure modes)
kubectl get events -n boilerhouse --sort-by=.lastTimestamp
```

## Observability Stack (Local Dev)

A reference Compose file for a local observability stack is not currently shipped with the Go rewrite. To set one up for development, run Prometheus, Grafana, and Tempo separately and point `OTEL_EXPORTER_OTLP_ENDPOINT` at your local collector.
