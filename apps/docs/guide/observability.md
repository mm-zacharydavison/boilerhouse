# Observability

Boilerhouse provides structured logging, Prometheus metrics, OpenTelemetry tracing, and an activity log for auditing. A bundled docker-compose stack runs Prometheus, Grafana, and Tempo for local development.

## Logging

Boilerhouse uses [Pino](https://getpino.io/) for structured JSON logging.

### Configuration

```bash
export LOG_LEVEL=info    # trace, debug, info, warn, error, fatal (default: info)
```

In development (`NODE_ENV` is not `production`), logs are automatically formatted with `pino-pretty` for readable colored output. In production, logs are emitted as JSON to stdout for ingestion by log aggregators (Datadog, Loki, CloudWatch, etc.).

### Log Context

All log entries include a `component` field identifying the subsystem that produced the entry (e.g., `TenantManager`, `PoolManager`, `GoldenCreator`). Domain operations add contextual fields such as `instanceId`, `tenantId`, and `workloadId` where applicable.

## Metrics

Prometheus-compatible metrics are exposed via an HTTP endpoint.

### Configuration

```bash
export METRICS_PORT=9464       # Prometheus endpoint port (default: 9464)
export METRICS_HOST=127.0.0.1  # Bind address (default: 127.0.0.1)
```

### Endpoint

```
GET http://127.0.0.1:9464/metrics
```

### Available Metrics

Metrics are organized by domain:

**Tenants**

| Metric | Type | Labels | Description |
|---|---|---|---|
| `boilerhouse_tenant_claims_total` | Counter | `workload`, `source`, `outcome` | Total claims (pool, cold, cold+data, existing) |
| `boilerhouse_tenant_claim_duration_seconds` | Histogram | `workload`, `source`, `tenant` | Time to complete a claim |
| `boilerhouse_tenant_releases_total` | Counter | `workload` | Total releases |
| `boilerhouse_tenant_usage_seconds_total` | Counter | `tenant`, `workload` | Cumulative usage time per tenant |
| `boilerhouse_tenant_active` | Gauge | `workload` | Currently active tenant claims |
| `boilerhouse_tenant_overlay_bytes` | Gauge | `tenant`, `workload` | Overlay archive size per tenant |

**Instances**

| Metric | Type | Labels | Description |
|---|---|---|---|
| `boilerhouse_instance_count` | Gauge | `workload`, `node`, `status` | Instance count by status |
| `boilerhouse_instance_transitions_total` | Counter | `from`, `to`, `workload` | State transitions |
| `boilerhouse_instance_transition_duration_seconds` | Histogram | `from`, `workload` | Duration of transitional states |
| `boilerhouse_instance_idle_timeouts_total` | Counter | -- | Idle timeout events |

**Pool**

| Metric | Type | Labels | Description |
|---|---|---|---|
| `boilerhouse_pool_depth` | Gauge | `workload` | Ready instances in pool |
| `boilerhouse_pool_cold_start_duration_seconds` | Histogram | `workload` | Time to start a new pool instance |

**Capacity**

| Metric | Type | Labels | Description |
|---|---|---|---|
| `boilerhouse_capacity_max` | Gauge | `node` | Maximum instances per node |
| `boilerhouse_capacity_used` | Gauge | `node` | Currently used instance slots |
| `boilerhouse_capacity_queue_depth` | Gauge | `node` | Queued operations waiting for capacity |

**Snapshots**

| Metric | Type | Labels | Description |
|---|---|---|---|
| `boilerhouse_snapshot_disk_bytes` | Gauge | `workload`, `type` | Total snapshot storage by type |
| `boilerhouse_snapshot_count` | Gauge | `workload`, `type` | Number of snapshots |
| `boilerhouse_snapshot_disk_avg_per_tenant_bytes` | Gauge | `workload` | Average tenant snapshot size |

**Triggers**

| Metric | Type | Labels | Description |
|---|---|---|---|
| `boilerhouse_trigger_dispatches_total` | Counter | `type`, `outcome` | Trigger dispatch attempts |
| `boilerhouse_trigger_dispatch_duration_seconds` | Histogram | `type` | End-to-end dispatch latency |

**Health Checks and WebSocket**

Health check probe counts/durations and WebSocket connection metrics are also available.

**Node / Container Resources**

Per-container CPU and memory usage metrics are collected from the runtime (Docker stats API or equivalent) and exposed as Prometheus gauges.

## Tracing

OpenTelemetry distributed tracing instruments HTTP requests, database queries, and runtime operations.

### Configuration

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

Tracing is enabled automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Spans are exported via OTLP HTTP to your collector.

### Instrumented Operations

- HTTP request handling (inbound API calls)
- Tenant claim/release operations
- Snapshot capture and restore
- Instance state transitions

Trace context is propagated across service boundaries using W3C Trace Context headers.

### Collector Setup

Any OpenTelemetry-compatible collector works:

- [Grafana Tempo](https://grafana.com/oss/tempo/) (included in the docker-compose stack)
- [Jaeger](https://www.jaegertracing.io/)
- [Honeycomb](https://www.honeycomb.io/)
- [Datadog](https://www.datadoghq.com/)

## Activity Log

All significant operations are recorded in the `activity_log` database table. This provides an audit trail independent of log aggregation infrastructure.

### Querying

```
GET /audit?limit=200&tenantId=...&instanceId=...&workloadId=...&event=...
```

All query parameters are optional. Results are returned in reverse chronological order (newest first). The `limit` parameter accepts values from 1 to 500 (default: 200).

### Event Types

The activity log records events such as:

- Instance creation, start, health check transitions
- Tenant claims and releases
- Hibernation and snapshot operations
- Idle timeouts
- Destruction
- Errors

Each entry includes `event`, `instanceId`, `workloadId`, `nodeId`, `tenantId`, `metadata` (JSON), and `createdAt` timestamp.

### Retention

The activity log supports configurable maximum event retention. When the limit is exceeded, the oldest events are pruned automatically after each insert.

## Dashboard

The built-in dashboard (`apps/dashboard`) provides a web UI for monitoring workloads, instances, and tenants. It connects to the Boilerhouse API and displays real-time status information.

## Deploy Stack

The included `docker-compose.yml` starts a local observability stack for development:

```bash
docker compose up -d
```

This starts:

| Service | Port | Description |
|---|---|---|
| **Prometheus** | `9090` | Metrics collection and querying |
| **Grafana** | `3003` | Dashboards and visualization (no login required) |
| **Tempo** | `4318` (OTLP), `3200` (query) | Distributed trace storage |
| **Redis** | `6379` | Optional queue backend |
| **MinIO** | `9000` (S3 API), `9001` (console) | S3-compatible object storage |

Then start the Boilerhouse API with tracing enabled:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces bun run dev
```

Prometheus is pre-configured to scrape the Boilerhouse metrics endpoint at `host.docker.internal:9464`. Grafana is provisioned with Prometheus and Tempo as data sources, along with pre-built dashboards.

## Related Pages

- [Configuration](./configuration.md) -- all observability-related environment variables
- [Storage](./storage.md) -- snapshot and overlay metrics
- [Quick Start](./quick-start.md) -- getting started with Boilerhouse
