/**
 * Container Lifecycle Metrics
 *
 * Histograms and counters for container operations.
 */

import { Counter, Histogram } from 'prom-client'
import { registry } from './registry'

// Histogram bucket definitions for different operation types
// Container operations typically take 1-30 seconds
const containerBuckets = [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60]

// Acquire/release histograms
export const containerAcquireDuration = new Histogram({
  name: 'boilerhouse_container_acquire_duration_seconds',
  help: 'Time to acquire container for tenant',
  labelNames: ['pool_id', 'status'],
  buckets: containerBuckets,
  registers: [registry],
})

export const containerReleaseDuration = new Histogram({
  name: 'boilerhouse_container_release_duration_seconds',
  help: 'Time to release container from tenant',
  labelNames: ['pool_id', 'status'],
  buckets: containerBuckets,
  registers: [registry],
})

// Create/destroy/wipe histograms
export const containerCreateDuration = new Histogram({
  name: 'boilerhouse_container_create_duration_seconds',
  help: 'Time to create new container',
  labelNames: ['pool_id', 'workload_id'],
  buckets: containerBuckets,
  registers: [registry],
})

export const containerDestroyDuration = new Histogram({
  name: 'boilerhouse_container_destroy_duration_seconds',
  help: 'Time to destroy container',
  labelNames: ['pool_id'],
  buckets: containerBuckets,
  registers: [registry],
})

export const containerWipeDuration = new Histogram({
  name: 'boilerhouse_container_wipe_duration_seconds',
  help: 'Time to wipe container state for new tenant',
  labelNames: ['pool_id'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

// Operation counters
export const containerOperationsTotal = new Counter({
  name: 'boilerhouse_container_operations_total',
  help: 'Total container operations',
  labelNames: ['pool_id', 'operation', 'status'],
  registers: [registry],
})

export const containerHealthCheckFailuresTotal = new Counter({
  name: 'boilerhouse_container_health_check_failures_total',
  help: 'Failed health checks',
  labelNames: ['pool_id'],
  registers: [registry],
})

// Affinity counters
export const affinityHitsTotal = new Counter({
  name: 'boilerhouse_affinity_hits_total',
  help: 'Times affinity match found',
  labelNames: ['pool_id'],
  registers: [registry],
})

export const affinityMissesTotal = new Counter({
  name: 'boilerhouse_affinity_misses_total',
  help: 'Times affinity match not found',
  labelNames: ['pool_id'],
  registers: [registry],
})

export const affinityEvictionsTotal = new Counter({
  name: 'boilerhouse_affinity_evictions_total',
  help: 'Affinity containers evicted due to timeout',
  labelNames: ['pool_id'],
  registers: [registry],
})
