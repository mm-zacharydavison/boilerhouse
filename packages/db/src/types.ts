/**
 * Database row types
 *
 * These types represent the raw rows stored in SQLite.
 * Repositories convert these to/from domain types.
 */

import type { ContainerId, ContainerStatus, PoolId, SyncId, TenantId } from '@boilerhouse/core'

/**
 * Container row from the containers table.
 */
export interface ContainerRow {
  container_id: ContainerId
  tenant_id: TenantId | null
  pool_id: PoolId
  socket_path: string
  state_dir: string
  secrets_dir: string
  last_activity: number
  status: ContainerStatus
  last_tenant_id: TenantId | null
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
