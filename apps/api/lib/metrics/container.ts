/**
 * Container Lifecycle Metrics
 *
 * Histograms and counters for container operations.
 */

import { Counter, Gauge, Histogram } from 'prom-client'
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

// Per-container info gauge (one entry per container, labels describe current state)
const containerInfo = new Gauge({
  name: 'boilerhouse_container_info',
  help: 'Per-container state (1 per container with informational labels)',
  labelNames: ['container_id', 'pool_id', 'workload_id', 'status', 'tenant_id'],
  registers: [registry],
})

/** Tracks current label values per container so we can remove stale entries on status change. */
const containerInfoLabels = new Map<string, Record<string, string>>()

export function setContainerInfo(
  containerId: string,
  poolId: string,
  workloadId: string,
  status: string,
  tenantId: string,
): void {
  const prev = containerInfoLabels.get(containerId)
  if (prev) {
    containerInfo.remove(prev)
  }
  const labels = {
    container_id: containerId,
    pool_id: poolId,
    workload_id: workloadId,
    status,
    tenant_id: tenantId,
  }
  containerInfo.set(labels, 1)
  containerInfoLabels.set(containerId, labels)
}

export const affinityHitsTotal = new Counter({
  name: 'boilerhouse_affinity_hits_total',
  help: 'Tenant reclaimed their previous container via lastTenantId match',
  labelNames: ['pool_id'],
  registers: [registry],
})

export function removeContainerInfo(containerId: string): void {
  const prev = containerInfoLabels.get(containerId)
  if (prev) {
    containerInfo.remove(prev)
    containerInfoLabels.delete(containerId)
  }
}
