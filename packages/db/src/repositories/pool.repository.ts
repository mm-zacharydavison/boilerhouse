/**
 * Pool Repository
 *
 * Persists pool configurations to SQLite.
 */

import type { Database } from 'bun:sqlite'
import type { PoolId } from '@boilerhouse/core'
import type { PoolRow } from '../types'

export interface PoolRecord {
  poolId: PoolId
  workloadId: string
  minSize: number
  maxSize: number
  idleTimeoutMs: number
  evictionIntervalMs: number
  acquireTimeoutMs: number
  networkName: string | null
  affinityTimeoutMs: number
  createdAt: Date
}

export class PoolRepository {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  /**
   * Save a pool config (insert or replace).
   */
  save(pool: Omit<PoolRecord, 'createdAt'>): void {
    this.db.run(
      `
      INSERT INTO pools (
        pool_id, workload_id, min_size, max_size, idle_timeout_ms,
        eviction_interval_ms, acquire_timeout_ms, network_name, affinity_timeout_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pool_id) DO UPDATE SET
        workload_id = excluded.workload_id,
        min_size = excluded.min_size,
        max_size = excluded.max_size,
        idle_timeout_ms = excluded.idle_timeout_ms,
        eviction_interval_ms = excluded.eviction_interval_ms,
        acquire_timeout_ms = excluded.acquire_timeout_ms,
        network_name = excluded.network_name,
        affinity_timeout_ms = excluded.affinity_timeout_ms
    `,
      [
        pool.poolId,
        pool.workloadId,
        pool.minSize,
        pool.maxSize,
        pool.idleTimeoutMs,
        pool.evictionIntervalMs,
        pool.acquireTimeoutMs,
        pool.networkName,
        pool.affinityTimeoutMs,
        Date.now(),
      ],
    )
  }

  /**
   * Delete a pool by ID.
   */
  delete(poolId: PoolId): void {
    this.db.run('DELETE FROM pools WHERE pool_id = ?', [poolId])
  }

  /**
   * Find a pool by ID.
   */
  findById(poolId: PoolId): PoolRecord | null {
    const row = this.db
      .query<PoolRow, [string]>('SELECT * FROM pools WHERE pool_id = ?')
      .get(poolId)

    return row ? this.rowToRecord(row) : null
  }

  /**
   * Find all pools.
   */
  findAll(): PoolRecord[] {
    const rows = this.db.query<PoolRow, []>('SELECT * FROM pools').all()
    return rows.map((row) => this.rowToRecord(row))
  }

  private rowToRecord(row: PoolRow): PoolRecord {
    return {
      poolId: row.pool_id as PoolId,
      workloadId: row.workload_id,
      minSize: row.min_size,
      maxSize: row.max_size,
      idleTimeoutMs: row.idle_timeout_ms,
      evictionIntervalMs: row.eviction_interval_ms,
      acquireTimeoutMs: row.acquire_timeout_ms,
      networkName: row.network_name,
      affinityTimeoutMs: row.affinity_timeout_ms,
      createdAt: new Date(row.created_at),
    }
  }
}
