/**
 * Activity Repository
 *
 * Persists activity log events to SQLite with auto-trimming.
 */

import type { Database } from 'bun:sqlite'
import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import type { ActivityLogRow } from '../types'

export interface ActivityEntry {
  id?: number
  eventType: string
  poolId: PoolId | null
  containerId: ContainerId | null
  tenantId: TenantId | null
  message: string
  metadata: Record<string, unknown> | null
  timestamp: Date
}

export class ActivityRepository {
  private db: Database
  private maxEvents: number

  constructor(db: Database, maxEvents = 1000) {
    this.db = db
    this.maxEvents = maxEvents
  }

  /**
   * Save an activity event.
   * Auto-trims old events if the limit is exceeded.
   */
  save(entry: Omit<ActivityEntry, 'id'>): number {
    const result = this.db.run(
      `
      INSERT INTO activity_log (event_type, pool_id, container_id, tenant_id, message, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        entry.eventType,
        entry.poolId,
        entry.containerId,
        entry.tenantId,
        entry.message,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.timestamp.getTime(),
      ],
    )

    // Trim old events periodically (every 100 inserts or so)
    if (result.lastInsertRowid && Number(result.lastInsertRowid) % 100 === 0) {
      this.trim()
    }

    return Number(result.lastInsertRowid)
  }

  /**
   * Trim old events to keep only maxEvents.
   */
  trim(): number {
    const result = this.db.run(
      `
      DELETE FROM activity_log
      WHERE id IN (
        SELECT id FROM activity_log
        ORDER BY timestamp DESC
        LIMIT -1 OFFSET ?
      )
    `,
      [this.maxEvents],
    )
    return result.changes
  }

  /**
   * Find recent events.
   */
  findRecent(limit = 50, offset = 0): ActivityEntry[] {
    const rows = this.db
      .query<ActivityLogRow, [number, number]>(
        'SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset)

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Find events by type.
   */
  findByType(eventType: string, limit = 50): ActivityEntry[] {
    const rows = this.db
      .query<ActivityLogRow, [string, number]>(
        'SELECT * FROM activity_log WHERE event_type = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(eventType, limit)

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Find events for a tenant.
   */
  findByTenant(tenantId: TenantId, limit = 50): ActivityEntry[] {
    const rows = this.db
      .query<ActivityLogRow, [string, number]>(
        'SELECT * FROM activity_log WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(tenantId, limit)

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Find events for a pool.
   */
  findByPool(poolId: PoolId, limit = 50): ActivityEntry[] {
    const rows = this.db
      .query<ActivityLogRow, [string, number]>(
        'SELECT * FROM activity_log WHERE pool_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(poolId, limit)

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Find events for a container.
   */
  findByContainer(containerId: ContainerId, limit = 50): ActivityEntry[] {
    const rows = this.db
      .query<ActivityLogRow, [string, number]>(
        'SELECT * FROM activity_log WHERE container_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(containerId, limit)

    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Count total events.
   */
  count(): number {
    const result = this.db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM activity_log')
      .get()
    return result?.count ?? 0
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.db.run('DELETE FROM activity_log')
  }

  private rowToEntry(row: ActivityLogRow): ActivityEntry {
    return {
      id: row.id,
      eventType: row.event_type,
      poolId: row.pool_id,
      containerId: row.container_id,
      tenantId: row.tenant_id,
      message: row.message,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      timestamp: new Date(row.timestamp),
    }
  }
}
