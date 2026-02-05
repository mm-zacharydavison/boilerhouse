# Observability Plan: Prometheus Metrics

This document outlines how to implement Prometheus metrics for Boilerhouse, enabling monitoring via any Prometheus-compatible platform (Grafana, Datadog, Victoria Metrics, etc.) and making the dashboard optional for most operational use cases.

## Goals

1. **Replace dashboard dependency** - All metrics currently shown in the dashboard should be queryable via PromQL
2. **Enable alerting** - Expose metrics that allow setting up alerts for critical conditions
3. **Support debugging** - Provide detailed metrics for troubleshooting sync failures, pool issues, and performance problems
4. **Minimal overhead** - Metrics collection should not significantly impact performance
5. **Standard conventions** - Follow Prometheus naming conventions and best practices

## Current State

| Component          | Metrics Available | Notes                                       |
|--------------------|-------------------|---------------------------------------------|
| ContainerPool      | None              | Pool state only available via API/dashboard |
| ContainerManager   | None              | No lifecycle timing metrics                 |
| SyncCoordinator    | None              | Sync status tracked in-memory only          |
| API Server         | None              | No request latency or error metrics         |
| Dashboard          | Displays stats    | Requires running separate app               |

### Dashboard Metrics to Replace

The dashboard currently displays:
- Total pools, containers (active/idle), active tenants
- Sync status counts (healthy/warning/error)
- Pool utilization percentages
- Sync job history with bytes/files transferred
- Activity log with events

All of these should be derivable from Prometheus metrics.

## Architecture

### Library Choice: prom-client

Use `prom-client`, the standard Prometheus client for Node.js/Bun:

```typescript
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'
```

**Why prom-client:**
- De facto standard for Node.js Prometheus metrics
- Built-in support for default metrics (process memory, CPU, event loop lag)
- Works with Bun
- Supports custom registries for testing

### Metrics Endpoint

Add `/metrics` endpoint to the API server:

```typescript
// apps/api/src/routes/metrics.ts
import { Elysia } from 'elysia'
import { registry } from '../lib/metrics'

export const metricsRoute = new Elysia()
  .get('/metrics', async () => {
    return new Response(await registry.metrics(), {
      headers: { 'Content-Type': registry.contentType }
    })
  })
```

### Package Structure

Create a new metrics module within the API:

```
apps/api/lib/metrics/
├── index.ts           # Registry and metric exports
├── pool.ts            # Pool-related metrics
├── sync.ts            # Sync-related metrics
├── http.ts            # HTTP request metrics (middleware)
└── container.ts       # Container lifecycle metrics
```

## Metrics Specification

### Pool Metrics

| Metric Name                           | Type      | Labels                   | Description                              |
|---------------------------------------|-----------|--------------------------|------------------------------------------|
| `boilerhouse_pool_size`               | Gauge     | `pool_id`, `workload_id` | Current total containers in pool         |
| `boilerhouse_pool_available`          | Gauge     | `pool_id`, `workload_id` | Idle containers ready for claim          |
| `boilerhouse_pool_borrowed`           | Gauge     | `pool_id`, `workload_id` | Containers assigned to tenants           |
| `boilerhouse_pool_pending`            | Gauge     | `pool_id`, `workload_id` | Containers being created/destroyed       |
| `boilerhouse_pool_min_size`           | Gauge     | `pool_id`, `workload_id` | Configured minimum pool size             |
| `boilerhouse_pool_max_size`           | Gauge     | `pool_id`, `workload_id` | Configured maximum pool size             |
| `boilerhouse_pool_target_size`        | Gauge     | `pool_id`, `workload_id` | Current target size (after scaling)      |

### Container Lifecycle Metrics

| Metric Name                                   | Type      | Labels                           | Description                         |
|-----------------------------------------------|-----------|----------------------------------|-------------------------------------|
| `boilerhouse_container_acquire_duration_seconds` | Histogram | `pool_id`, `status`           | Time to acquire container for tenant|
| `boilerhouse_container_release_duration_seconds` | Histogram | `pool_id`, `status`           | Time to release container           |
| `boilerhouse_container_create_duration_seconds`  | Histogram | `pool_id`, `workload_id`      | Time to create new container        |
| `boilerhouse_container_destroy_duration_seconds` | Histogram | `pool_id`                     | Time to destroy container           |
| `boilerhouse_container_wipe_duration_seconds`    | Histogram | `pool_id`                     | Time to wipe container state        |
| `boilerhouse_container_operations_total`         | Counter   | `pool_id`, `operation`, `status`| Total operations (create/destroy/wipe) |
| `boilerhouse_container_health_check_failures_total` | Counter | `pool_id`                   | Failed health checks                |

### Affinity Metrics

| Metric Name                              | Type    | Labels               | Description                           |
|------------------------------------------|---------|----------------------|---------------------------------------|
| `boilerhouse_affinity_hits_total`        | Counter | `pool_id`            | Times affinity match found            |
| `boilerhouse_affinity_misses_total`      | Counter | `pool_id`            | Times affinity match not found        |
| `boilerhouse_affinity_evictions_total`   | Counter | `pool_id`            | Affinity containers evicted (timeout) |
| `boilerhouse_affinity_reservations`      | Gauge   | `pool_id`            | Current affinity reservations held    |

### Sync Metrics

| Metric Name                                  | Type      | Labels                                  | Description                        |
|----------------------------------------------|-----------|------------------------------------------|-----------------------------------|
| `boilerhouse_sync_operations_total`          | Counter   | `workload_id`, `direction`, `status`     | Total sync operations             |
| `boilerhouse_sync_duration_seconds`          | Histogram | `workload_id`, `direction`, `mode`       | Sync operation duration           |
| `boilerhouse_sync_bytes_transferred_total`   | Counter   | `workload_id`, `direction`               | Cumulative bytes synced           |
| `boilerhouse_sync_files_transferred_total`   | Counter   | `workload_id`, `direction`               | Cumulative files synced           |
| `boilerhouse_sync_concurrent_operations`     | Gauge     | `workload_id`                            | Currently running syncs           |
| `boilerhouse_sync_queue_length`              | Gauge     | `workload_id`                            | Pending sync operations           |
| `boilerhouse_sync_periodic_jobs_active`      | Gauge     | `workload_id`                            | Active periodic sync jobs         |
| `boilerhouse_sync_errors_total`              | Counter   | `workload_id`, `error_type`              | Sync errors by type               |
| `boilerhouse_sync_bisync_resync_total`       | Counter   | `workload_id`                            | Bisync resync fallback events     |

**Label values:**
- `direction`: `upload`, `download`, `bidirectional`
- `mode`: `sync`, `bisync`, `copy`
- `status`: `success`, `failure`, `timeout`
- `error_type`: `rclone_error`, `timeout`, `permission_denied`, `network_error`

### HTTP Metrics

| Metric Name                              | Type      | Labels                       | Description                    |
|------------------------------------------|-----------|------------------------------|--------------------------------|
| `boilerhouse_http_request_duration_seconds` | Histogram | `method`, `path`, `status` | Request latency                |
| `boilerhouse_http_requests_total`        | Counter   | `method`, `path`, `status`   | Total requests                 |

### System Metrics

| Metric Name                          | Type  | Labels | Description                     |
|--------------------------------------|-------|--------|---------------------------------|
| `boilerhouse_info`                   | Gauge | `version` | Static info gauge (always 1) |
| `boilerhouse_start_time_seconds`     | Gauge | None   | Unix timestamp of process start |

Plus default Node.js metrics from `collectDefaultMetrics()`:
- `process_cpu_seconds_total`
- `process_resident_memory_bytes`
- `nodejs_eventloop_lag_seconds`
- `nodejs_active_handles_total`

## Implementation

### Core Metrics Module

```typescript
// apps/api/lib/metrics/index.ts
import { Registry, collectDefaultMetrics } from 'prom-client'

export const registry = new Registry()

// Add default Node.js metrics
collectDefaultMetrics({ register: registry })

// Re-export all metric instances
export * from './pool'
export * from './sync'
export * from './container'
export * from './http'
```

### Pool Metrics Implementation

```typescript
// apps/api/lib/metrics/pool.ts
import { Gauge } from 'prom-client'
import { registry } from './index'

export const poolSize = new Gauge({
  name: 'boilerhouse_pool_size',
  help: 'Current total containers in pool',
  labelNames: ['pool_id', 'workload_id'],
  registers: [registry],
})

export const poolAvailable = new Gauge({
  name: 'boilerhouse_pool_available',
  help: 'Idle containers ready for claim',
  labelNames: ['pool_id', 'workload_id'],
  registers: [registry],
})

// ... other gauges

// Update function called by ContainerPool
export function updatePoolMetrics(pool: ContainerPool): void {
  const labels = { pool_id: pool.id, workload_id: pool.workloadId }
  poolSize.set(labels, pool.size)
  poolAvailable.set(labels, pool.available)
  poolBorrowed.set(labels, pool.borrowed)
  poolPending.set(labels, pool.pending)
}
```

### Histogram Buckets

Use appropriate bucket sizes for different operations:

```typescript
// Container operations (typically 1-30 seconds)
const containerBuckets = [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60]

// Sync operations (can take minutes)
const syncBuckets = [1, 5, 10, 30, 60, 120, 300, 600]

// HTTP requests (typically milliseconds to seconds)
const httpBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
```

### Integration Points

#### ContainerPool

```typescript
// apps/api/lib/container/pool.ts
import { updatePoolMetrics, containerAcquireDuration, affinityHits } from '../metrics'

class ContainerPool {
  async acquireForTenant(tenantId: TenantId): Promise<PoolContainer> {
    const end = containerAcquireDuration.startTimer({ pool_id: this.id })
    try {
      // Check affinity
      const affinityContainer = this.affinityContainers.get(tenantId)
      if (affinityContainer) {
        affinityHits.inc({ pool_id: this.id })
        // ...
      } else {
        affinityMisses.inc({ pool_id: this.id })
      }

      const container = await this.pool.acquire()
      end({ status: 'success' })
      updatePoolMetrics(this)
      return container
    } catch (error) {
      end({ status: 'failure' })
      throw error
    }
  }
}
```

#### SyncCoordinator

```typescript
// apps/api/lib/sync/coordinator.ts
import { syncOperationsTotal, syncDuration, syncBytesTransferred } from '../metrics'

class SyncCoordinator {
  async executeSync(spec: SyncSpec, container: PoolContainer, direction: SyncDirection): Promise<void> {
    const end = syncDuration.startTimer({
      workload_id: container.workloadId,
      direction,
      mode: spec.mode
    })

    try {
      const result = await this.executor.execute(spec, container, direction)

      syncOperationsTotal.inc({
        workload_id: container.workloadId,
        direction,
        status: 'success'
      })
      syncBytesTransferred.inc(
        { workload_id: container.workloadId, direction },
        result.bytesTransferred
      )
      end({ status: 'success' })
    } catch (error) {
      syncOperationsTotal.inc({
        workload_id: container.workloadId,
        direction,
        status: 'failure'
      })
      syncErrorsTotal.inc({
        workload_id: container.workloadId,
        error_type: classifyError(error)
      })
      end({ status: 'failure' })
      throw error
    }
  }
}
```

#### HTTP Middleware

```typescript
// apps/api/lib/metrics/http.ts
import { Elysia } from 'elysia'
import { Histogram, Counter } from 'prom-client'
import { registry } from './index'

const httpRequestDuration = new Histogram({
  name: 'boilerhouse_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

export const metricsMiddleware = new Elysia()
  .onRequest(({ request, store }) => {
    store.requestStart = performance.now()
  })
  .onAfterResponse(({ request, response, store }) => {
    const duration = (performance.now() - store.requestStart) / 1000
    const path = normalizePath(new URL(request.url).pathname)

    httpRequestDuration.observe(
      { method: request.method, path, status: response.status },
      duration
    )
  })

// Normalize paths to avoid high cardinality
// /api/v1/tenants/abc123 -> /api/v1/tenants/:id
function normalizePath(path: string): string {
  return path
    .replace(/\/tenants\/[^/]+/, '/tenants/:id')
    .replace(/\/containers\/[^/]+/, '/containers/:id')
    .replace(/\/pools\/[^/]+/, '/pools/:id')
}
```

## Dashboard Metric Equivalents

| Dashboard Display       | Prometheus Query                                                      |
|-------------------------|-----------------------------------------------------------------------|
| Total Pools             | `count(boilerhouse_pool_size)`                                        |
| Total Containers        | `sum(boilerhouse_pool_size)`                                          |
| Active Containers       | `sum(boilerhouse_pool_borrowed)`                                      |
| Idle Containers         | `sum(boilerhouse_pool_available)`                                     |
| Pool Utilization %      | `boilerhouse_pool_borrowed / boilerhouse_pool_size * 100`             |
| Sync Running Count      | `sum(boilerhouse_sync_concurrent_operations)`                         |
| Sync Error Count        | `sum(increase(boilerhouse_sync_errors_total[1h]))`                    |
| Avg Acquire Time        | `histogram_quantile(0.5, boilerhouse_container_acquire_duration_seconds)` |
| Request Rate            | `sum(rate(boilerhouse_http_requests_total[5m]))`                      |
| Error Rate              | `sum(rate(boilerhouse_http_requests_total{status=~"5.."}[5m]))`       |

## Alerting Rules

Example Prometheus alerting rules:

```yaml
groups:
  - name: boilerhouse
    rules:
      - alert: PoolExhausted
        expr: boilerhouse_pool_available == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Pool {{ $labels.pool_id }} has no available containers"

      - alert: HighSyncErrorRate
        expr: rate(boilerhouse_sync_errors_total[5m]) > 0.1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High sync error rate for workload {{ $labels.workload_id }}"

      - alert: SlowContainerAcquisition
        expr: histogram_quantile(0.99, rate(boilerhouse_container_acquire_duration_seconds_bucket[5m])) > 30
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container acquisition p99 latency > 30s for pool {{ $labels.pool_id }}"

      - alert: HighPoolUtilization
        expr: (boilerhouse_pool_borrowed / boilerhouse_pool_size) > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Pool {{ $labels.pool_id }} is > 90% utilized"
```

## Grafana Dashboard

A Grafana dashboard JSON can be generated to visualize:

**Row 1: Overview**
- Total pools (stat)
- Total containers (stat)
- Active containers (stat)
- Idle containers (stat)
- Overall utilization % (gauge)

**Row 2: Pool Details**
- Pool size by pool (time series)
- Pool utilization by pool (time series)
- Container acquisition latency p50/p95/p99 (time series)

**Row 3: Sync Operations**
- Sync operations/minute by direction (time series)
- Sync duration by workload (heatmap)
- Sync errors by type (time series)
- Bytes transferred (time series)

**Row 4: API Performance**
- Request rate by endpoint (time series)
- Request latency by endpoint (heatmap)
- Error rate by endpoint (time series)

## Tasks

### Phase 1: Core Infrastructure

- [ ] 1.1 Add `prom-client` dependency to `apps/api`
- [ ] 1.2 Create `apps/api/lib/metrics/` module structure
- [ ] 1.3 Create metrics registry with default metrics
- [ ] 1.4 Add `/metrics` endpoint to API server
- [ ] 1.5 Add HTTP request metrics middleware

### Phase 2: Pool Metrics

- [ ] 2.1 Define pool gauge metrics (size, available, borrowed, pending)
- [ ] 2.2 Add `updatePoolMetrics()` calls to ContainerPool state changes
- [ ] 2.3 Define container lifecycle histograms (acquire, release, create, destroy, wipe)
- [ ] 2.4 Instrument ContainerPool.acquireForTenant() with timing
- [ ] 2.5 Instrument ContainerPool.releaseForTenant() with timing
- [ ] 2.6 Instrument ContainerManager.createContainer() with timing
- [ ] 2.7 Instrument ContainerManager.destroyContainer() with timing
- [ ] 2.8 Add affinity metrics (hits, misses, evictions)

### Phase 3: Sync Metrics

- [ ] 3.1 Define sync metrics (operations, duration, bytes, files, errors)
- [ ] 3.2 Instrument SyncCoordinator.executeSync() with timing and counters
- [ ] 3.3 Parse rclone output for bytes/files transferred
- [ ] 3.4 Add sync queue and concurrency gauges
- [ ] 3.5 Add periodic job count gauge

### Phase 4: Documentation & Dashboards

- [ ] 4.1 Create example Prometheus alerting rules file
- [ ] 4.2 Create example Grafana dashboard JSON
- [ ] 4.3 Document metrics in README or dedicated docs page
- [ ] 4.4 Add metrics documentation to API docs

### Phase 5: Testing

- [ ] 5.1 Unit tests for metrics module (verify labels, values)
- [ ] 5.2 Integration test for /metrics endpoint
- [ ] 5.3 Verify metrics work with actual Prometheus scrape

## Configuration

Add environment variables for metrics configuration:

| Variable                        | Default | Description                           |
|---------------------------------|---------|---------------------------------------|
| `BOILERHOUSE_METRICS_ENABLED`   | `true`  | Enable/disable metrics endpoint       |
| `BOILERHOUSE_METRICS_PATH`      | `/metrics` | Path for metrics endpoint          |
| `BOILERHOUSE_METRICS_PREFIX`    | `boilerhouse_` | Prefix for all metric names    |

## Security Considerations

- The `/metrics` endpoint should not require authentication by default (Prometheus needs to scrape it)
- Consider adding optional basic auth for the metrics endpoint in production
- Avoid high-cardinality labels (no tenant_id in labels - use container_id sparingly)
- Rate limit the metrics endpoint if exposed publicly

## Notes

### Label Cardinality

Keep label cardinality low to avoid memory issues:
- **pool_id**: Low cardinality (typically < 10 pools)
- **workload_id**: Low cardinality (typically < 20 workloads)
- **tenant_id**: **DO NOT USE** as label (can be thousands)
- **container_id**: Use sparingly, only for debugging metrics

### Metric Naming Conventions

Following Prometheus best practices:
- Prefix all metrics with `boilerhouse_`
- Use `_total` suffix for counters
- Use `_seconds` for time durations (not milliseconds)
- Use `_bytes` for sizes
- Use snake_case for names

### Future Considerations

- **Push gateway**: For short-lived containers or batch jobs, consider Prometheus Pushgateway
- **OpenTelemetry**: Consider migrating to OpenTelemetry for unified metrics/traces/logs
- **Exemplars**: Add trace ID exemplars to histograms for correlation with distributed tracing
