/**
 * Database row types
 *
 * These types represent the raw rows stored in SQLite.
 * Repositories convert these to/from domain types.
 */

import type { ContainerId, PoolId, SyncId, TenantId } from '@boilerhouse/core'

/**
 * Claim row from the claims table.
 */
export interface ClaimRow {
  container_id: ContainerId
  tenant_id: TenantId
  pool_id: PoolId
  last_activity: number
  claimed_at: number
}

/**
 * Pool row from the pools table.
 */
export interface PoolRow {
  pool_id: PoolId
  workload_id: string
  min_size: number
  max_size: number
  idle_timeout_ms: number
  eviction_interval_ms: number
  acquire_timeout_ms: number
  network_name: string | null
  affinity_timeout_ms: number
  created_at: number
}

/**
 * Affinity reservation row from the affinity_reservations table.
 */
export interface AffinityReservationRow {
  tenant_id: TenantId
  container_id: ContainerId
  pool_id: PoolId
  expires_at: number
  created_at: number
}

/**
 * Sync status row from the sync_status table.
 */
export interface SyncStatusRow {
  tenant_id: TenantId
  sync_id: SyncId
  last_sync_at: number | null
  pending_count: number
  state: 'idle' | 'syncing' | 'error'
  updated_at: number
}

/**
 * Sync error row from the sync_errors table.
 */
export interface SyncErrorRow {
  id: number
  tenant_id: TenantId
  sync_id: SyncId
  message: string
  mapping: string | null
  timestamp: number
}

/**
 * Activity log row from the activity_log table.
 */
export interface ActivityLogRow {
  id: number
  event_type: string
  pool_id: PoolId | null
  container_id: ContainerId | null
  tenant_id: TenantId | null
  message: string
  metadata: string | null
  timestamp: number
}

/**
 * Schema version row.
 */
export interface SchemaVersionRow {
  version: number
  applied_at: number
}
