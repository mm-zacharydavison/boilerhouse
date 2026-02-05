/**
 * Container Repository
 *
 * Persists PoolContainer state to SQLite.
 */

import type { Database } from 'bun:sqlite'
import type {
  ContainerId,
  ContainerStatus,
  PoolContainer,
  PoolId,
  TenantId,
} from '@boilerhouse/core'
import type { ContainerRow } from '../types'

export class ContainerRepository {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  /**
   * Save a container to the database.
   */
  save(container: PoolContainer): void {
    this.db.run(
      `
      INSERT INTO containers (
        container_id, tenant_id, pool_id, socket_path, state_dir, secrets_dir,
        last_activity, status, last_tenant_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(container_id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        pool_id = excluded.pool_id,
        socket_path = excluded.socket_path,
        state_dir = excluded.state_dir,
        secrets_dir = excluded.secrets_dir,
        last_activity = excluded.last_activity,
        status = excluded.status,
        last_tenant_id = excluded.last_tenant_id
    `,
      [
        container.containerId,
        container.tenantId,
        container.poolId,
        container.socketPath,
        container.stateDir,
        container.secretsDir,
        container.lastActivity.getTime(),
        container.status,
        container.lastTenantId ?? null,
        Date.now(),
      ],
    )
  }

  /**
   * Update the tenant assignment for a container.
   */
  updateTenant(containerId: ContainerId, tenantId: TenantId | null, status: ContainerStatus): void {
    this.db.run(
      `
      UPDATE containers
      SET tenant_id = ?, status = ?, last_activity = ?
      WHERE container_id = ?
    `,
      [tenantId, status, Date.now(), containerId],
    )
  }

  /**
   * Update the last tenant ID (for affinity tracking).
   */
  updateLastTenantId(containerId: ContainerId, lastTenantId: TenantId | null): void {
    this.db.run(
      `
      UPDATE containers
      SET last_tenant_id = ?
      WHERE container_id = ?
    `,
      [lastTenantId, containerId],
    )
  }

  /**
   * Update the last activity timestamp.
   */
  updateLastActivity(containerId: ContainerId): void {
    this.db.run(
      `
      UPDATE containers
      SET last_activity = ?
      WHERE container_id = ?
    `,
      [Date.now(), containerId],
    )
  }

  /**
   * Delete a container from the database.
   */
  delete(containerId: ContainerId): void {
    this.db.run('DELETE FROM containers WHERE container_id = ?', [containerId])
  }

  /**
   * Find a container by ID.
   */
  findById(containerId: ContainerId): PoolContainer | null {
    const row = this.db
      .query<ContainerRow, [string]>('SELECT * FROM containers WHERE container_id = ?')
      .get(containerId)

    return row ? this.rowToContainer(row) : null
  }

  /**
   * Find a container by tenant ID.
   */
  findByTenantId(tenantId: TenantId): PoolContainer | null {
    const row = this.db
      .query<ContainerRow, [string]>('SELECT * FROM containers WHERE tenant_id = ?')
      .get(tenantId)

    return row ? this.rowToContainer(row) : null
  }

  /**
   * Find all containers for a pool.
   */
  findByPoolId(poolId: PoolId): PoolContainer[] {
    const rows = this.db
      .query<ContainerRow, [string]>('SELECT * FROM containers WHERE pool_id = ?')
      .all(poolId)

    return rows.map((row) => this.rowToContainer(row))
  }

  /**
   * Find all containers with a specific status.
   */
  findByStatus(status: ContainerStatus): PoolContainer[] {
    const rows = this.db
      .query<ContainerRow, [string]>('SELECT * FROM containers WHERE status = ?')
      .all(status)

    return rows.map((row) => this.rowToContainer(row))
  }

  /**
   * Find all containers.
   */
  findAll(): PoolContainer[] {
    const rows = this.db.query<ContainerRow, []>('SELECT * FROM containers').all()
    return rows.map((row) => this.rowToContainer(row))
  }

  /**
   * Get container IDs only (for reconciliation).
   */
  getAllContainerIds(): ContainerId[] {
    const rows = this.db
      .query<{ container_id: string }, []>('SELECT container_id FROM containers')
      .all()
    return rows.map((row) => row.container_id)
  }

  /**
   * Delete containers not in the given list (orphan cleanup).
   */
  deleteNotIn(containerIds: ContainerId[]): number {
    if (containerIds.length === 0) {
      const result = this.db.run('DELETE FROM containers')
      return result.changes
    }

    const placeholders = containerIds.map(() => '?').join(',')
    const result = this.db.run(
      `DELETE FROM containers WHERE container_id NOT IN (${placeholders})`,
      containerIds,
    )
    return result.changes
  }

  /**
   * Convert a database row to a PoolContainer.
   */
  private rowToContainer(row: ContainerRow): PoolContainer {
    return {
      containerId: row.container_id,
      tenantId: row.tenant_id,
      poolId: row.pool_id,
      socketPath: row.socket_path,
      stateDir: row.state_dir,
      secretsDir: row.secrets_dir,
      lastActivity: new Date(row.last_activity),
      status: row.status,
      lastTenantId: row.last_tenant_id,
    }
  }
}
