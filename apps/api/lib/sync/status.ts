/**
 * Sync Status Tracker
 *
 * Tracks sync operation status per tenant and sync spec.
 * Records last sync time, pending operations, and errors.
 *
 * All state is stored in the SyncStatusRepository (DB as source of truth).
 */

import type { SyncId, SyncStatus, TenantId } from '@boilerhouse/core'
import type { SyncStatusRepository } from '@boilerhouse/db'

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
  private syncStatusRepo: SyncStatusRepository

  constructor(syncStatusRepo: SyncStatusRepository) {
    this.syncStatusRepo = syncStatusRepo
  }

  /**
   * Get status for a tenant + sync spec.
   */
  getStatus(tenantId: TenantId, syncId: SyncId): SyncStatus {
    const dbEntry = this.syncStatusRepo.findByTenantAndSync(tenantId, syncId)
    const errors = this.syncStatusRepo.findErrors(tenantId, syncId)

    if (!dbEntry) {
      return {
        syncId,
        tenantId,
        pendingCount: 0,
        errors: [],
        state: 'idle',
      }
    }

    return {
      syncId: dbEntry.syncId,
      tenantId: dbEntry.tenantId,
      lastSyncAt: dbEntry.lastSyncAt ?? undefined,
      pendingCount: dbEntry.pendingCount,
      errors: errors.map((e) => ({
        timestamp: e.timestamp,
        message: e.message,
        mapping: e.mapping ?? undefined,
      })),
      state: dbEntry.state,
    }
  }

  /**
   * Get all statuses for a tenant.
   */
  getStatusesForTenant(tenantId: TenantId): SyncStatus[] {
    const dbEntries = this.syncStatusRepo.findByTenant(tenantId)
    return dbEntries.map((entry) => {
      const errors = this.syncStatusRepo.findErrors(entry.tenantId, entry.syncId)
      return {
        syncId: entry.syncId,
        tenantId: entry.tenantId,
        lastSyncAt: entry.lastSyncAt ?? undefined,
        pendingCount: entry.pendingCount,
        errors: errors.map((e) => ({
          timestamp: e.timestamp,
          message: e.message,
          mapping: e.mapping ?? undefined,
        })),
        state: entry.state,
      }
    })
  }

  /**
   * Mark a sync as started.
   */
  markSyncStarted(tenantId: TenantId, syncId: SyncId): void {
    const existing = this.syncStatusRepo.findByTenantAndSync(tenantId, syncId)
    const pendingCount = (existing?.pendingCount ?? 0) + 1

    this.syncStatusRepo.save({
      tenantId,
      syncId,
      lastSyncAt: existing?.lastSyncAt ?? null,
      pendingCount,
      state: 'syncing',
      updatedAt: new Date(),
    })
  }

  /**
   * Mark a sync as completed successfully.
   */
  markSyncCompleted(tenantId: TenantId, syncId: SyncId): void {
    const existing = this.syncStatusRepo.findByTenantAndSync(tenantId, syncId)
    const pendingCount = Math.max(0, (existing?.pendingCount ?? 1) - 1)
    const state = pendingCount > 0 ? 'syncing' : 'idle'

    // Clear errors on successful completion when idle
    if (state === 'idle') {
      this.syncStatusRepo.clearErrors(tenantId, syncId)
    }

    this.syncStatusRepo.save({
      tenantId,
      syncId,
      lastSyncAt: new Date(),
      pendingCount,
      state,
      updatedAt: new Date(),
    })
  }

  /**
   * Mark a sync as failed.
   */
  markSyncFailed(tenantId: TenantId, syncId: SyncId, error: string, mapping?: string): void {
    const existing = this.syncStatusRepo.findByTenantAndSync(tenantId, syncId)
    const pendingCount = Math.max(0, (existing?.pendingCount ?? 1) - 1)

    this.syncStatusRepo.save({
      tenantId,
      syncId,
      lastSyncAt: existing?.lastSyncAt ?? null,
      pendingCount,
      state: 'error',
      updatedAt: new Date(),
    })
    this.syncStatusRepo.addError(tenantId, syncId, error, mapping)
  }

  /**
   * Clear status for a tenant.
   */
  clearTenant(tenantId: TenantId): void {
    this.syncStatusRepo.deleteByTenant(tenantId)
  }

  /**
   * Clear status for a specific tenant + sync spec.
   */
  clearStatus(tenantId: TenantId, syncId: SyncId): void {
    this.syncStatusRepo.deleteByTenantAndSync(tenantId, syncId)
  }

  /**
   * Get all pending syncs.
   */
  getPendingSyncs(): Array<{ tenantId: TenantId; syncId: SyncId; pendingCount: number }> {
    return this.syncStatusRepo.findWithPending().map((e) => ({
      tenantId: e.tenantId,
      syncId: e.syncId,
      pendingCount: e.pendingCount,
    }))
  }

  /**
   * Get all syncs in error state.
   */
  getErrorSyncs(): Array<{ tenantId: TenantId; syncId: SyncId; errors: SyncError[] }> {
    const errorEntries = this.syncStatusRepo.findInErrorState()
    return errorEntries.map((e) => {
      const errors = this.syncStatusRepo.findErrors(e.tenantId, e.syncId)
      return {
        tenantId: e.tenantId,
        syncId: e.syncId,
        errors: errors.map((err) => ({
          timestamp: err.timestamp,
          message: err.message,
          mapping: err.mapping ?? undefined,
        })),
      }
    })
  }
}
