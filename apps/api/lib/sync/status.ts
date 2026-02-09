/**
 * Sync Status Tracker
 *
 * Tracks sync operation status per tenant and sync spec.
 * Records last sync time, pending operations, and errors.
 *
 * All state is stored in SQLite via Drizzle ORM (DB as source of truth).
 */

import type { SyncId, SyncStatus, TenantId } from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { and, desc, eq, gt, notInArray } from 'drizzle-orm'

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

const DEFAULT_MAX_ERRORS = 10

export class SyncStatusTracker {
  private db: DrizzleDb
  private maxErrorsPerSync: number

  constructor(db: DrizzleDb, maxErrorsPerSync = DEFAULT_MAX_ERRORS) {
    this.db = db
    this.maxErrorsPerSync = maxErrorsPerSync
  }

  /**
   * Get status for a tenant + sync spec.
   */
  getStatus(tenantId: TenantId, syncId: SyncId): SyncStatus {
    const dbEntry = this.db
      .select()
      .from(schema.syncStatus)
      .where(and(eq(schema.syncStatus.tenantId, tenantId), eq(schema.syncStatus.syncId, syncId)))
      .get()
    const errors = this.db
      .select()
      .from(schema.syncErrors)
      .where(and(eq(schema.syncErrors.tenantId, tenantId), eq(schema.syncErrors.syncId, syncId)))
      .orderBy(desc(schema.syncErrors.timestamp), desc(schema.syncErrors.id))
      .all()

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
    const dbEntries = this.db
      .select()
      .from(schema.syncStatus)
      .where(eq(schema.syncStatus.tenantId, tenantId))
      .all()
    return dbEntries.map((entry) => {
      const errors = this.db
        .select()
        .from(schema.syncErrors)
        .where(
          and(
            eq(schema.syncErrors.tenantId, entry.tenantId),
            eq(schema.syncErrors.syncId, entry.syncId),
          ),
        )
        .orderBy(desc(schema.syncErrors.timestamp), desc(schema.syncErrors.id))
        .all()
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
    const existing = this.db
      .select()
      .from(schema.syncStatus)
      .where(and(eq(schema.syncStatus.tenantId, tenantId), eq(schema.syncStatus.syncId, syncId)))
      .get()
    const pendingCount = (existing?.pendingCount ?? 0) + 1

    this.db
      .insert(schema.syncStatus)
      .values({
        tenantId,
        syncId,
        lastSyncAt: existing?.lastSyncAt ?? null,
        pendingCount,
        state: 'syncing',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.syncStatus.tenantId, schema.syncStatus.syncId],
        set: {
          lastSyncAt: existing?.lastSyncAt ?? null,
          pendingCount,
          state: 'syncing',
          updatedAt: new Date(),
        },
      })
      .run()
  }

  /**
   * Mark a sync as completed successfully.
   */
  markSyncCompleted(tenantId: TenantId, syncId: SyncId): void {
    const existing = this.db
      .select()
      .from(schema.syncStatus)
      .where(and(eq(schema.syncStatus.tenantId, tenantId), eq(schema.syncStatus.syncId, syncId)))
      .get()
    const pendingCount = Math.max(0, (existing?.pendingCount ?? 1) - 1)
    const state = pendingCount > 0 ? 'syncing' : 'idle'

    // Clear errors on successful completion when idle
    if (state === 'idle') {
      this.db
        .delete(schema.syncErrors)
        .where(and(eq(schema.syncErrors.tenantId, tenantId), eq(schema.syncErrors.syncId, syncId)))
        .run()
    }

    this.db
      .insert(schema.syncStatus)
      .values({
        tenantId,
        syncId,
        lastSyncAt: new Date(),
        pendingCount,
        state,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.syncStatus.tenantId, schema.syncStatus.syncId],
        set: {
          lastSyncAt: new Date(),
          pendingCount,
          state,
          updatedAt: new Date(),
        },
      })
      .run()
  }

  /**
   * Mark a sync as failed.
   */
  markSyncFailed(tenantId: TenantId, syncId: SyncId, error: string, mapping?: string): void {
    const existing = this.db
      .select()
      .from(schema.syncStatus)
      .where(and(eq(schema.syncStatus.tenantId, tenantId), eq(schema.syncStatus.syncId, syncId)))
      .get()
    const pendingCount = Math.max(0, (existing?.pendingCount ?? 1) - 1)

    this.db
      .insert(schema.syncStatus)
      .values({
        tenantId,
        syncId,
        lastSyncAt: existing?.lastSyncAt ?? null,
        pendingCount,
        state: 'error',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.syncStatus.tenantId, schema.syncStatus.syncId],
        set: {
          lastSyncAt: existing?.lastSyncAt ?? null,
          pendingCount,
          state: 'error',
          updatedAt: new Date(),
        },
      })
      .run()

    // Add error and trim in a transaction
    this.db.transaction((tx) => {
      tx.insert(schema.syncErrors)
        .values({
          tenantId,
          syncId,
          message: error,
          mapping: mapping ?? null,
          timestamp: new Date(),
        })
        .run()

      // Keep only the N most recent errors
      const keepIds = tx
        .select({ id: schema.syncErrors.id })
        .from(schema.syncErrors)
        .where(and(eq(schema.syncErrors.tenantId, tenantId), eq(schema.syncErrors.syncId, syncId)))
        .orderBy(desc(schema.syncErrors.timestamp), desc(schema.syncErrors.id))
        .limit(this.maxErrorsPerSync)
        .all()
        .map((r) => r.id)

      if (keepIds.length > 0) {
        tx.delete(schema.syncErrors)
          .where(
            and(
              eq(schema.syncErrors.tenantId, tenantId),
              eq(schema.syncErrors.syncId, syncId),
              notInArray(schema.syncErrors.id, keepIds),
            ),
          )
          .run()
      }
    })
  }

  /**
   * Check if a tenant has ever completed a sync for a given sync spec.
   * Returns false for first-time tenants (no entry or lastSyncAt is null).
   */
  hasSyncedBefore(tenantId: TenantId, syncId: SyncId): boolean {
    const entry = this.db
      .select({ lastSyncAt: schema.syncStatus.lastSyncAt })
      .from(schema.syncStatus)
      .where(and(eq(schema.syncStatus.tenantId, tenantId), eq(schema.syncStatus.syncId, syncId)))
      .get()
    return entry?.lastSyncAt != null
  }

  /**
   * Clear status for a tenant.
   */
  clearTenant(tenantId: TenantId): void {
    this.db.transaction((tx) => {
      tx.delete(schema.syncErrors).where(eq(schema.syncErrors.tenantId, tenantId)).run()
      tx.delete(schema.syncStatus).where(eq(schema.syncStatus.tenantId, tenantId)).run()
    })
  }

  /**
   * Clear status for a specific tenant + sync spec.
   */
  clearStatus(tenantId: TenantId, syncId: SyncId): void {
    this.db.transaction((tx) => {
      tx.delete(schema.syncErrors)
        .where(and(eq(schema.syncErrors.tenantId, tenantId), eq(schema.syncErrors.syncId, syncId)))
        .run()
      tx.delete(schema.syncStatus)
        .where(and(eq(schema.syncStatus.tenantId, tenantId), eq(schema.syncStatus.syncId, syncId)))
        .run()
    })
  }

  /**
   * Get all pending syncs.
   */
  getPendingSyncs(): Array<{ tenantId: TenantId; syncId: SyncId; pendingCount: number }> {
    return this.db
      .select({
        tenantId: schema.syncStatus.tenantId,
        syncId: schema.syncStatus.syncId,
        pendingCount: schema.syncStatus.pendingCount,
      })
      .from(schema.syncStatus)
      .where(gt(schema.syncStatus.pendingCount, 0))
      .all()
  }

  /**
   * Get all syncs in error state.
   */
  getErrorSyncs(): Array<{ tenantId: TenantId; syncId: SyncId; errors: SyncError[] }> {
    const errorEntries = this.db
      .select()
      .from(schema.syncStatus)
      .where(eq(schema.syncStatus.state, 'error'))
      .all()
    return errorEntries.map((e) => {
      const errors = this.db
        .select()
        .from(schema.syncErrors)
        .where(
          and(eq(schema.syncErrors.tenantId, e.tenantId), eq(schema.syncErrors.syncId, e.syncId)),
        )
        .orderBy(desc(schema.syncErrors.timestamp), desc(schema.syncErrors.id))
        .all()
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
