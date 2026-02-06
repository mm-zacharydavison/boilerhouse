/**
 * Pool Metrics
 *
 * Gauges tracking container pool state.
 */

import { Counter, Gauge } from 'prom-client'
import { registry } from './registry'

const labelNames = ['pool_id', 'workload_id'] as const

export const poolSize = new Gauge({
  name: 'boilerhouse_pool_size',
  help: 'Current total containers in pool',
  labelNames,
  registers: [registry],
})

export const poolAvailable = new Gauge({
  name: 'boilerhouse_pool_available',
  help: 'Idle containers ready for claim',
  labelNames,
  registers: [registry],
})

export const poolBorrowed = new Gauge({
  name: 'boilerhouse_pool_borrowed',
  help: 'Containers assigned to tenants',
  labelNames,
  registers: [registry],
})

export const poolPending = new Gauge({
  name: 'boilerhouse_pool_pending',
  help: 'Containers being created or destroyed',
  labelNames,
  registers: [registry],
})

export const poolMinIdle = new Gauge({
  name: 'boilerhouse_pool_min_idle',
  help: 'Configured minimum idle containers',
  labelNames,
  registers: [registry],
})

export const poolMaxSize = new Gauge({
  name: 'boilerhouse_pool_max_size',
  help: 'Configured maximum pool size',
  labelNames,
  registers: [registry],
})

// Idle reaper metrics
export const idleReaperWatchesActive = new Gauge({
  name: 'boilerhouse_idle_reaper_watches_active',
  help: 'Number of containers currently being watched for filesystem inactivity',
  labelNames: ['pool_id'],
  registers: [registry],
})

export const idleReaperFileWatchCount = new Gauge({
  name: 'boilerhouse_idle_reaper_file_watch_count',
  help: 'Number of files/directories being polled for a watched container',
  labelNames: ['pool_id', 'container_id'],
  registers: [registry],
})

export const idleReaperExpirations = new Counter({
  name: 'boilerhouse_idle_reaper_expirations_total',
  help: 'Containers released due to filesystem idle TTL expiry',
  labelNames: ['pool_id'],
  registers: [registry],
})

export const idleReaperResets = new Counter({
  name: 'boilerhouse_idle_reaper_resets_total',
  help: 'Timer resets from filesystem activity',
  labelNames: ['pool_id'],
  registers: [registry],
})

/**
 * Update all pool metrics for a given pool.
 * Call this after any pool state change.
 */
export function updatePoolMetrics(stats: {
  poolId: string
  workloadId: string
  size: number
  available: number
  borrowed: number
  pending: number
  minIdle: number
  max: number
}): void {
  const labels = { pool_id: stats.poolId, workload_id: stats.workloadId }
  poolSize.set(labels, stats.size)
  poolAvailable.set(labels, stats.available)
  poolBorrowed.set(labels, stats.borrowed)
  poolPending.set(labels, stats.pending)
  poolMinIdle.set(labels, stats.minIdle)
  poolMaxSize.set(labels, stats.max)
}

/**
 * Remove metrics for a pool that has been destroyed.
 */
export function removePoolMetrics(poolId: string, workloadId: string): void {
  const labels = { pool_id: poolId, workload_id: workloadId }
  poolSize.remove(labels)
  poolAvailable.remove(labels)
  poolBorrowed.remove(labels)
  poolPending.remove(labels)
  poolMinIdle.remove(labels)
  poolMaxSize.remove(labels)
}
