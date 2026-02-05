/**
 * Sync Status Repository
 *
 * Persists sync status and errors to SQLite.
 */

import type { Database } from 'bun:sqlite'
import type { SyncId, TenantId } from '@boilerhouse/core'
import type { SyncErrorRow, SyncStatusRow } from '../types'

export interface SyncStatusEntry {
  tenantId: TenantId
  syncId: SyncId
  lastSyncAt: Date | null
  pendingCount: number
  state: 'idle' | 'syncing' | 'error'
  updatedAt: Date
}

export interface SyncErrorEntry {
  id: number
  tenantId: TenantId
  syncId: SyncId
  message: string
  mapping: string | null
  timestamp: Date
}

export class SyncStatusRepository {
  private db: Database
  private maxErrorsPerSync: number

  constructor(db: Database, maxErrorsPerSync = 10) {
    this.db = db
    this.maxErrorsPerSync = maxErrorsPerSync
  }

  /**
   * Save or update sync status.
   */
  save(entry: SyncStatusEntry): void {
    this.db.run(
      `
      INSERT INTO sync_status (tenant_id, sync_id, last_sync_at, pending_count, state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, sync_id) DO UPDATE SET
        last_sync_at = excluded.last_sync_at,
        pending_count = excluded.pending_count,
        state = excluded.state,
        updated_at = excluded.updated_at
    `,
      [
        entry.tenantId,
        entry.syncId,
        entry.lastSyncAt?.getTime() ?? null,
        entry.pendingCount,
        entry.state,
        entry.updatedAt.getTime(),
      ],
    )
  }

  /**
   * Add a sync error.
   */
  addError(tenantId: TenantId, syncId: SyncId, message: string, mapping?: string): void {
    this.db.transaction(() => {
      // Add the new error
      this.db.run(
        `
        INSERT INTO sync_errors (tenant_id, sync_id, message, mapping, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `,
        [tenantId, syncId, message, mapping ?? null, Date.now()],
      )

      // Trim old errors to keep only maxErrorsPerSync (delete all except the N most recent)
      // Use id DESC as secondary sort since timestamp may have same value for rapid insertions
      this.db.run(
        `
        DELETE FROM sync_errors
        WHERE tenant_id = ? AND sync_id = ? AND id NOT IN (
          SELECT id FROM sync_errors
          WHERE tenant_id = ? AND sync_id = ?
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        )
      `,
        [tenantId, syncId, tenantId, syncId, this.maxErrorsPerSync],
      )
    })()
  }

  /**
   * Clear errors for a tenant/sync combination.
   */
  clearErrors(tenantId: TenantId, syncId: SyncId): void {
    this.db.run('DELETE FROM sync_errors WHERE tenant_id = ? AND sync_id = ?', [tenantId, syncId])
  }

  /**
   * Find sync status by tenant and sync ID.
   */
  findByTenantAndSync(tenantId: TenantId, syncId: SyncId): SyncStatusEntry | null {
    const row = this.db
      .query<SyncStatusRow, [string, string]>(
        'SELECT * FROM sync_status WHERE tenant_id = ? AND sync_id = ?',
      )
      .get(tenantId, syncId)

    return row ? this.rowToEntry(row) : null
  }

  /**
   * Find all sync statuses for a tenant.
   */
  findByTenant(tenantId: TenantId): SyncStatusEntry[] {
    const rows = this.db
      .query<SyncStatusRow, [string]>('SELECT * FROM sync_status WHERE tenant_id = ?')
      .all(tenantId)

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Find errors for a tenant/sync combination.
   */
  findErrors(tenantId: TenantId, syncId: SyncId): SyncErrorEntry[] {
    const rows = this.db
      .query<SyncErrorRow, [string, string]>(
        'SELECT * FROM sync_errors WHERE tenant_id = ? AND sync_id = ? ORDER BY timestamp DESC, id DESC',
      )
      .all(tenantId, syncId)

    return rows.map((row) => this.rowToError(row))
  }

  /**
   * Delete all sync status and errors for a tenant.
   */
  deleteByTenant(tenantId: TenantId): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM sync_errors WHERE tenant_id = ?', [tenantId])
      this.db.run('DELETE FROM sync_status WHERE tenant_id = ?', [tenantId])
    })()
  }

  /**
   * Delete sync status and errors for a specific tenant/sync.
   */
  deleteByTenantAndSync(tenantId: TenantId, syncId: SyncId): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM sync_errors WHERE tenant_id = ? AND sync_id = ?', [tenantId, syncId])
      this.db.run('DELETE FROM sync_status WHERE tenant_id = ? AND sync_id = ?', [tenantId, syncId])
    })()
  }

  /**
   * Find all statuses in error state.
   */
  findInErrorState(): SyncStatusEntry[] {
    const rows = this.db
      .query<SyncStatusRow, []>("SELECT * FROM sync_status WHERE state = 'error'")
      .all()

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Find all statuses with pending operations.
   */
  findWithPending(): SyncStatusEntry[] {
    const rows = this.db
      .query<SyncStatusRow, []>('SELECT * FROM sync_status WHERE pending_count > 0')
      .all()

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Find all sync statuses.
   */
  findAll(): SyncStatusEntry[] {
    const rows = this.db.query<SyncStatusRow, []>('SELECT * FROM sync_status').all()
    return rows.map((row) => this.rowToEntry(row))
  }

  private rowToEntry(row: SyncStatusRow): SyncStatusEntry {
    return {
      tenantId: row.tenant_id,
      syncId: row.sync_id,
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
      pendingCount: row.pending_count,
      state: row.state,
      updatedAt: new Date(row.updated_at),
    }
  }

  private rowToError(row: SyncErrorRow): SyncErrorEntry {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      syncId: row.sync_id,
      message: row.message,
      mapping: row.mapping,
      timestamp: new Date(row.timestamp),
    }
  }
}
