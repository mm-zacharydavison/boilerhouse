/**
 * Sync Status Tracker
 *
 * Tracks sync operation status per tenant and sync spec.
 * Records last sync time, pending operations, and errors.
 */

import type { SyncId, SyncStatus, TenantId } from '@boilerhouse/core'

/**
 * Represents an error that occurred during a sync operation.
 */
export interface SyncError {
  /**
   * When the error occurred.
   * @example new Date('2024-01-15T14:30:00Z')
   */
  timestamp: Date

  /**
   * Error message describing what went wrong.
   * @example 'rclone: Failed to copy: AccessDenied'
   */
  message: string

  /**
   * The container path of the mapping that failed, if applicable.
   * @example '/data/sessions'
   */
  mapping?: string
}

/**
 * Tracks the sync status for a specific tenant and sync spec combination.
 */
export interface SyncStatusEntry {
  /**
   * ID of the sync specification.
   * @example 'ml-training-sync'
   */
  syncId: SyncId

  /**
   * ID of the tenant.
   * @example 'tenant-123'
   */
  tenantId: TenantId

  /**
   * Timestamp of the last successful sync.
   * @example new Date('2024-01-15T14:30:00Z')
   */
  lastSyncAt?: Date

  /** Number of sync operations currently in progress. */
  pendingCount: number

  /**
   * Recent errors from failed sync operations.
   */
  errors: SyncError[]

  /**
   * Current state of the sync.
   * - `idle`: No sync in progress, ready for new operations
   * - `syncing`: One or more sync operations in progress
   * - `error`: Last sync operation failed
   * @example 'idle'
   */
  state: 'idle' | 'syncing' | 'error'
}

export class SyncStatusTracker {
  private statuses: Map<string, SyncStatusEntry> = new Map()

  /** Maximum number of errors to retain per tenant/sync */
  private maxErrors = 10

  /**
   * Create a unique key for tenant + sync spec combination.
   */
  private makeKey(tenantId: TenantId, syncId: SyncId): string {
    return `${tenantId}:${syncId}`
  }

  /**
   * Get or create a status entry for a tenant + sync spec.
   */
  private getOrCreate(tenantId: TenantId, syncId: SyncId): SyncStatusEntry {
    const key = this.makeKey(tenantId, syncId)
    let entry = this.statuses.get(key)

    if (!entry) {
      entry = {
        syncId,
        tenantId,
        pendingCount: 0,
        errors: [],
        state: 'idle',
      }
      this.statuses.set(key, entry)
    }

    return entry
  }

  /**
   * Get status for a tenant + sync spec.
   */
  getStatus(tenantId: TenantId, syncId: SyncId): SyncStatus {
    const entry = this.getOrCreate(tenantId, syncId)
    return {
      syncId: entry.syncId,
      tenantId: entry.tenantId,
      lastSyncAt: entry.lastSyncAt,
      pendingCount: entry.pendingCount,
      errors: entry.errors,
      state: entry.state,
    }
  }

  /**
   * Get all statuses for a tenant.
   */
  getStatusesForTenant(tenantId: TenantId): SyncStatus[] {
    const results: SyncStatus[] = []
    for (const [key, entry] of this.statuses) {
      if (key.startsWith(`${tenantId}:`)) {
        results.push({
          syncId: entry.syncId,
          tenantId: entry.tenantId,
          lastSyncAt: entry.lastSyncAt,
          pendingCount: entry.pendingCount,
          errors: entry.errors,
          state: entry.state,
        })
      }
    }
    return results
  }

  /**
   * Mark a sync as started.
   */
  markSyncStarted(tenantId: TenantId, syncId: SyncId): void {
    const entry = this.getOrCreate(tenantId, syncId)
    entry.state = 'syncing'
    entry.pendingCount++
  }

  /**
   * Mark a sync as completed successfully.
   */
  markSyncCompleted(tenantId: TenantId, syncId: SyncId): void {
    const entry = this.getOrCreate(tenantId, syncId)
    entry.lastSyncAt = new Date()
    entry.pendingCount = Math.max(0, entry.pendingCount - 1)
    entry.state = entry.pendingCount > 0 ? 'syncing' : 'idle'

    // Clear errors on successful sync
    if (entry.state === 'idle') {
      entry.errors = []
    }
  }

  /**
   * Mark a sync as failed.
   */
  markSyncFailed(tenantId: TenantId, syncId: SyncId, error: string, mapping?: string): void {
    const entry = this.getOrCreate(tenantId, syncId)
    entry.pendingCount = Math.max(0, entry.pendingCount - 1)
    entry.state = 'error'

    entry.errors.push({
      timestamp: new Date(),
      message: error,
      mapping,
    })

    // Trim old errors
    if (entry.errors.length > this.maxErrors) {
      entry.errors = entry.errors.slice(-this.maxErrors)
    }
  }

  /**
   * Clear status for a tenant.
   */
  clearTenant(tenantId: TenantId): void {
    const keysToDelete: string[] = []
    for (const key of this.statuses.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      this.statuses.delete(key)
    }
  }

  /**
   * Clear status for a specific tenant + sync spec.
   */
  clearStatus(tenantId: TenantId, syncId: SyncId): void {
    const key = this.makeKey(tenantId, syncId)
    this.statuses.delete(key)
  }

  /**
   * Clear all statuses.
   */
  clear(): void {
    this.statuses.clear()
  }

  /**
   * Get all pending syncs.
   */
  getPendingSyncs(): Array<{ tenantId: TenantId; syncId: SyncId; pendingCount: number }> {
    const pending: Array<{ tenantId: TenantId; syncId: SyncId; pendingCount: number }> = []
    for (const entry of this.statuses.values()) {
      if (entry.pendingCount > 0) {
        pending.push({
          tenantId: entry.tenantId,
          syncId: entry.syncId,
          pendingCount: entry.pendingCount,
        })
      }
    }
    return pending
  }

  /**
   * Get all syncs in error state.
   */
  getErrorSyncs(): Array<{ tenantId: TenantId; syncId: SyncId; errors: SyncError[] }> {
    const errored: Array<{ tenantId: TenantId; syncId: SyncId; errors: SyncError[] }> = []
    for (const entry of this.statuses.values()) {
      if (entry.state === 'error') {
        errored.push({
          tenantId: entry.tenantId,
          syncId: entry.syncId,
          errors: entry.errors,
        })
      }
    }
    return errored
  }
}
