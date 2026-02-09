/**
 * Sync Metrics
 *
 * Metrics for rclone sync operations.
 */

import { Counter, Gauge, Histogram } from 'prom-client'
import { registry } from './registry'

// Sync operations can take minutes
const syncBuckets = [1, 5, 10, 30, 60, 120, 300, 600]

export const syncOperationsTotal = new Counter({
  name: 'boilerhouse_sync_operations_total',
  help: 'Total sync operations',
  labelNames: ['workload_id', 'direction', 'status'],
  registers: [registry],
})

export const syncDuration = new Histogram({
  name: 'boilerhouse_sync_duration_seconds',
  help: 'Sync operation duration',
  labelNames: ['workload_id', 'direction', 'mode'],
  buckets: syncBuckets,
  registers: [registry],
})

export const syncBytesTransferredTotal = new Counter({
  name: 'boilerhouse_sync_bytes_transferred_total',
  help: 'Cumulative bytes synced',
  labelNames: ['workload_id', 'direction'],
  registers: [registry],
})

export const syncFilesTransferredTotal = new Counter({
  name: 'boilerhouse_sync_files_transferred_total',
  help: 'Cumulative files synced',
  labelNames: ['workload_id', 'direction'],
  registers: [registry],
})

export const syncConcurrentOperations = new Gauge({
  name: 'boilerhouse_sync_concurrent_operations',
  help: 'Currently running sync operations',
  labelNames: ['workload_id'],
  registers: [registry],
})

export const syncQueueLength = new Gauge({
  name: 'boilerhouse_sync_queue_length',
  help: 'Pending sync operations in queue',
  labelNames: ['workload_id'],
  registers: [registry],
})

export const syncPeriodicJobsActive = new Gauge({
  name: 'boilerhouse_sync_periodic_jobs_active',
  help: 'Active periodic sync jobs',
  labelNames: ['workload_id'],
  registers: [registry],
})

export const syncErrorsTotal = new Counter({
  name: 'boilerhouse_sync_errors_total',
  help: 'Sync errors by type',
  labelNames: ['workload_id', 'error_type'],
  registers: [registry],
})

/**
 * Classify sync error for error_type label.
 */
export function classifySyncError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()

  if (lower.includes('timeout')) return 'timeout'
  if (lower.includes('permission') || lower.includes('access')) return 'permission_denied'
  if (lower.includes('network') || lower.includes('connection')) return 'network_error'
  if (lower.includes('rclone')) return 'rclone_error'
  return 'unknown'
}
