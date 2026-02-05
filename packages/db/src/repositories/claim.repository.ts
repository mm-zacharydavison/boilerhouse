/**
 * Claim Repository
 *
 * Persists tenant-to-container claims to SQLite.
 * Tracks which containers are claimed by which tenants.
 */

import type { Database } from 'bun:sqlite'
import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import type { ClaimRow } from '../types'

export interface Claim {
  containerId: ContainerId
  tenantId: TenantId
  poolId: PoolId
  lastActivity: Date
  claimedAt: Date
}

export class ClaimRepository {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  /**
   * Save a claim (insert or replace).
   */
  save(claim: Omit<Claim, 'claimedAt'>): void {
    this.db.run(
      `
      INSERT INTO claims (container_id, tenant_id, pool_id, last_activity, claimed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(container_id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        pool_id = excluded.pool_id,
        last_activity = excluded.last_activity
    `,
      [claim.containerId, claim.tenantId, claim.poolId, claim.lastActivity.getTime(), Date.now()],
    )
  }

  /**
   * Delete a claim by container ID.
   */
  delete(containerId: ContainerId): void {
    this.db.run('DELETE FROM claims WHERE container_id = ?', [containerId])
  }

  /**
   * Find claim by container ID.
   */
  findByContainerId(containerId: ContainerId): Claim | null {
    const row = this.db
      .query<ClaimRow, [string]>('SELECT * FROM claims WHERE container_id = ?')
      .get(containerId)

    return row ? this.rowToClaim(row) : null
  }

  /**
   * Find claim by tenant ID.
   */
  findByTenantId(tenantId: TenantId): Claim | null {
    const row = this.db
      .query<ClaimRow, [string]>('SELECT * FROM claims WHERE tenant_id = ?')
      .get(tenantId)

    return row ? this.rowToClaim(row) : null
  }

  /**
   * Find all claims for a pool.
   */
  findByPoolId(poolId: PoolId): Claim[] {
    const rows = this.db
      .query<ClaimRow, [string]>('SELECT * FROM claims WHERE pool_id = ?')
      .all(poolId)

    return rows.map((row) => this.rowToClaim(row))
  }

  /**
   * Count claims in a pool.
   */
  countByPoolId(poolId: PoolId): number {
    const result = this.db
      .query<{ count: number }, [string]>('SELECT COUNT(*) as count FROM claims WHERE pool_id = ?')
      .get(poolId)
    return result?.count ?? 0
  }

  /**
   * Update last activity timestamp for a container.
   */
  updateLastActivity(containerId: ContainerId): void {
    this.db.run('UPDATE claims SET last_activity = ? WHERE container_id = ?', [
      Date.now(),
      containerId,
    ])
  }

  /**
   * Find claims with stale activity (last_activity older than threshold).
   */
  findStale(maxIdleMs: number): Claim[] {
    const threshold = Date.now() - maxIdleMs
    const rows = this.db
      .query<ClaimRow, [number]>('SELECT * FROM claims WHERE last_activity < ?')
      .all(threshold)

    return rows.map((row) => this.rowToClaim(row))
  }

  /**
   * Find all claims.
   */
  findAll(): Claim[] {
    const rows = this.db.query<ClaimRow, []>('SELECT * FROM claims').all()
    return rows.map((row) => this.rowToClaim(row))
  }

  /**
   * Delete claims for containers not in the given list (stale cleanup).
   */
  deleteNotIn(containerIds: ContainerId[]): number {
    if (containerIds.length === 0) {
      const result = this.db.run('DELETE FROM claims')
      return result.changes
    }

    const placeholders = containerIds.map(() => '?').join(',')
    const result = this.db.run(
      `DELETE FROM claims WHERE container_id NOT IN (${placeholders})`,
      containerIds,
    )
    return result.changes
  }

  private rowToClaim(row: ClaimRow): Claim {
    return {
      containerId: row.container_id,
      tenantId: row.tenant_id,
      poolId: row.pool_id,
      lastActivity: new Date(row.last_activity),
      claimedAt: new Date(row.claimed_at),
    }
  }
}
