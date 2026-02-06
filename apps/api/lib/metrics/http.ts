/**
 * HTTP Request Metrics
 *
 * Request latency and count metrics with path normalization.
 */

import { Elysia } from 'elysia'
import { Counter, Histogram } from 'prom-client'
import { registry } from './registry'

// HTTP requests typically take milliseconds to seconds
const httpBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export const httpRequestDuration = new Histogram({
  name: 'boilerhouse_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'path', 'status'],
  buckets: httpBuckets,
  registers: [registry],
})

export const httpRequestsTotal = new Counter({
  name: 'boilerhouse_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [registry],
})

/**
 * Normalize paths to avoid high cardinality labels.
 * Replaces dynamic segments with :id placeholders.
 */
function normalizePath(path: string): string {
  return path
    .replace(/\/tenants\/[^/]+/, '/tenants/:id')
    .replace(/\/containers\/[^/]+/, '/containers/:id')
    .replace(/\/pools\/[^/]+/, '/pools/:id')
    .replace(/\/workloads\/[^/]+/, '/workloads/:id')
}

/**
 * Elysia plugin for HTTP request metrics.
 * Tracks request duration and counts with path normalization.
 */
export const httpMetricsMiddleware = new Elysia({ name: 'http-metrics' })
  .derive(() => ({
    requestStart: performance.now(),
  }))
  .onAfterResponse(({ request, set, requestStart }) => {
    const duration = (performance.now() - requestStart) / 1000
    const url = new URL(request.url)
    const path = normalizePath(url.pathname)
    const status = String(set.status ?? 200)

    httpRequestDuration.observe({ method: request.method, path, status }, duration)
    httpRequestsTotal.inc({ method: request.method, path, status })
  })
