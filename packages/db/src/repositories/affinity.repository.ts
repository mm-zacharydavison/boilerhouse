/**
 * Affinity Repository
 *
 * Persists tenant affinity reservations to SQLite.
 * Affinity reservations hold a container for a tenant after release,
 * allowing quick re-acquisition with state intact.
 */

import type { Database } from 'bun:sqlite'
import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import type { AffinityReservationRow } from '../types'

export interface AffinityReservation {
  tenantId: TenantId
  containerId: ContainerId
  poolId: PoolId
  expiresAt: Date
  createdAt: Date
}

export class AffinityRepository {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  /**
   * Save an affinity reservation.
   */
  save(reservation: Omit<AffinityReservation, 'createdAt'>): void {
    this.db.run(
      `
      INSERT INTO affinity_reservations (tenant_id, container_id, pool_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        container_id = excluded.container_id,
        pool_id = excluded.pool_id,
        expires_at = excluded.expires_at
    `,
      [
        reservation.tenantId,
        reservation.containerId,
        reservation.poolId,
        reservation.expiresAt.getTime(),
        Date.now(),
      ],
    )
  }

  /**
   * Delete a reservation by tenant ID.
   */
  delete(tenantId: TenantId): void {
    this.db.run('DELETE FROM affinity_reservations WHERE tenant_id = ?', [tenantId])
  }

  /**
   * Delete a reservation by container ID.
   */
  deleteByContainerId(containerId: ContainerId): void {
    this.db.run('DELETE FROM affinity_reservations WHERE container_id = ?', [containerId])
  }

  /**
   * Find a reservation by tenant ID.
   */
  findByTenantId(tenantId: TenantId): AffinityReservation | null {
    const row = this.db
      .query<AffinityReservationRow, [string]>(
        'SELECT * FROM affinity_reservations WHERE tenant_id = ?',
      )
      .get(tenantId)

    return row ? this.rowToReservation(row) : null
  }

  /**
   * Find all reservations for a pool.
   */
  findByPoolId(poolId: PoolId): AffinityReservation[] {
    const rows = this.db
      .query<AffinityReservationRow, [string]>(
        'SELECT * FROM affinity_reservations WHERE pool_id = ?',
      )
      .all(poolId)

    return rows.map((row) => this.rowToReservation(row))
  }

  /**
   * Find all active (non-expired) reservations.
   */
  findActive(): AffinityReservation[] {
    const now = Date.now()
    const rows = this.db
      .query<AffinityReservationRow, [number]>(
        'SELECT * FROM affinity_reservations WHERE expires_at > ?',
      )
      .all(now)

    return rows.map((row) => this.rowToReservation(row))
  }

  /**
   * Find all reservations.
   */
  findAll(): AffinityReservation[] {
    const rows = this.db
      .query<AffinityReservationRow, []>('SELECT * FROM affinity_reservations')
      .all()

    return rows.map((row) => this.rowToReservation(row))
  }

  /**
   * Delete expired reservations.
   * Returns the number of deleted rows.
   */
  deleteExpired(): number {
    const now = Date.now()
    const result = this.db.run('DELETE FROM affinity_reservations WHERE expires_at <= ?', [now])
    return result.changes
  }

  /**
   * Convert a database row to an AffinityReservation.
   */
  private rowToReservation(row: AffinityReservationRow): AffinityReservation {
    return {
      tenantId: row.tenant_id,
      containerId: row.container_id,
      poolId: row.pool_id,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    }
  }
}
