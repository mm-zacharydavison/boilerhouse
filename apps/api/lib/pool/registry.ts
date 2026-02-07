/**
 * Pool Registry
 *
 * Manages multiple container pools, each associated with a workload.
 * Provides centralized access to pools and their containers.
 *
 * Pool configs stored in SQLite via Drizzle ORM.
 * Runtime pool instances are held in memory.
 */

import type {
  ContainerId,
  ContainerInfo,
  ContainerStatus,
  PoolContainer,
  PoolId,
  PoolInfo,
  TenantId,
  WorkloadId,
  WorkloadSpec,
} from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { and, eq } from 'drizzle-orm'
import { type ActivityLog, logPoolCreated, logPoolScaled } from '../activity'
import type { ContainerManager } from '../container/manager'
import { ContainerPool, type PoolStats } from '../container/pool'
import { PoolNotFoundError, WorkloadNotFoundError } from '../errors'
import type { Logger } from '../logger'
import type { WorkloadRegistry } from '../workload'

/**
 * Pool registry for managing multiple pools
 */
export class PoolRegistry {
  private pools: Map<PoolId, ContainerPool> = new Map()
  private manager: ContainerManager
  private workloadRegistry: WorkloadRegistry
  private activityLog: ActivityLog
  private db: DrizzleDb
  private log: Logger

  constructor(
    manager: ContainerManager,
    workloadRegistry: WorkloadRegistry,
    activityLog: ActivityLog,
    db: DrizzleDb,
    logger: Logger,
  ) {
    this.manager = manager
    this.workloadRegistry = workloadRegistry
    this.activityLog = activityLog
    this.db = db
    this.log = logger.child({ component: 'PoolRegistry' })
  }

  /**
   * Restore all pools from the database.
   * Creates pool instances from persisted configs. Skips pools whose workload is no longer registered.
   */
  restoreFromDb(): number {
    const poolRecords = this.db.select().from(schema.pools).all()
    let restored = 0

    for (const record of poolRecords) {
      if (this.pools.has(record.poolId)) continue

      const workload = this.workloadRegistry.get(record.workloadId)
      if (!workload) {
        this.log.info(
          { poolId: record.poolId, workloadId: record.workloadId },
          'Skipping pool: workload not found',
        )
        continue
      }

      const pool = new ContainerPool(
        this.manager,
        {
          workload,
          poolId: record.poolId,
          minIdle: record.minIdle,
          maxSize: record.maxSize,
          idleTimeoutMs: record.idleTimeoutMs,
          evictionIntervalMs: record.evictionIntervalMs,
          acquireTimeoutMs: record.acquireTimeoutMs,
          networks: record.networks ?? undefined,
          fileIdleTtl: record.fileIdleTtl ?? undefined,
        },
        this.db,
        this.log,
      )
      pool.start()

      this.pools.set(record.poolId, pool)
      restored++
    }

    return restored
  }

  /**
   * Create a new pool for a workload
   */
  createPool(
    poolId: PoolId,
    workloadId: WorkloadId,
    config?: Partial<{
      minIdle: number
      maxSize: number
      idleTimeoutMs: number
      networks: string[]
      acquireTimeoutMs: number
      fileIdleTtl: number
    }>,
  ): ContainerPool {
    if (this.pools.has(poolId)) {
      throw new Error(`Pool ${poolId} already exists`)
    }

    const workload = this.workloadRegistry.get(workloadId)
    if (!workload) {
      throw new WorkloadNotFoundError(workloadId)
    }

    // Use workload pool config as defaults, then override with explicit config
    const workloadPoolDefaults = {
      minIdle: workload.pool?.minIdle,
      maxSize: workload.pool?.maxSize,
      idleTimeoutMs: workload.pool?.idleTimeout,
      networks: workload.pool?.networks ?? workload.networks,
      fileIdleTtl: workload.pool?.fileIdleTtl,
    }

    const pool = new ContainerPool(
      this.manager,
      {
        workload,
        poolId,
        ...workloadPoolDefaults,
        ...config,
      },
      this.db,
      this.log,
    )
    pool.start()

    this.pools.set(poolId, pool)

    // Persist pool config to DB (uses resolved values from pool stats)
    const resolvedNetworks = config?.networks ?? workloadPoolDefaults.networks ?? null
    this.db
      .insert(schema.pools)
      .values({
        poolId,
        workloadId,
        minIdle: pool.getStats().minIdle,
        maxSize: pool.getStats().max,
        idleTimeoutMs: config?.idleTimeoutMs ?? workloadPoolDefaults.idleTimeoutMs ?? 300000,
        evictionIntervalMs: 30000,
        acquireTimeoutMs: config?.acquireTimeoutMs ?? 30000,
        networks: resolvedNetworks,
        fileIdleTtl: config?.fileIdleTtl ?? workloadPoolDefaults.fileIdleTtl ?? null,
      })
      .onConflictDoUpdate({
        target: schema.pools.poolId,
        set: {
          workloadId,
          minIdle: pool.getStats().minIdle,
          maxSize: pool.getStats().max,
          idleTimeoutMs: config?.idleTimeoutMs ?? workloadPoolDefaults.idleTimeoutMs ?? 300000,
          acquireTimeoutMs: config?.acquireTimeoutMs ?? 30000,
          networks: resolvedNetworks,
          fileIdleTtl: config?.fileIdleTtl ?? workloadPoolDefaults.fileIdleTtl ?? null,
        },
      })
      .run()

    logPoolCreated(poolId, workloadId, this.activityLog)

    return pool
  }

  /**
   * Get a pool by ID
   */
  getPool(poolId: PoolId): ContainerPool | undefined {
    return this.pools.get(poolId)
  }

  /**
   * Check if a pool exists
   */
  hasPool(poolId: PoolId): boolean {
    return this.pools.has(poolId)
  }

  /**
   * Get all pools as a read-only map.
   */
  getPools(): ReadonlyMap<PoolId, ContainerPool> {
    return this.pools
  }

  /**
   * List all pool IDs
   */
  listPoolIds(): PoolId[] {
    return Array.from(this.pools.keys())
  }

  /**
   * Get pool info for API responses
   */
  getPoolInfo(poolId: PoolId): PoolInfo | undefined {
    const pool = this.pools.get(poolId)
    if (!pool) return undefined

    const stats = pool.getStats()
    const workload = pool.getWorkload()
    const poolRecord = this.db
      .select()
      .from(schema.pools)
      .where(eq(schema.pools.poolId, poolId))
      .get()
    const createdAt = poolRecord?.createdAt ?? new Date()

    // Determine pool health status
    let status: 'healthy' | 'degraded' | 'error' = 'healthy'
    if (stats.available === 0 && stats.borrowed === stats.max) {
      status = 'degraded'
    }
    if (stats.size === 0 && stats.pending === 0) {
      status = 'error'
    }

    const lastError = pool.getLastError()

    return {
      id: poolId,
      workloadId: workload.id,
      workloadName: workload.name,
      image: workload.image,
      minIdle: stats.minIdle,
      maxSize: stats.max,
      currentSize: stats.size,
      claimedCount: stats.borrowed,
      idleCount: stats.available,
      status,
      createdAt: createdAt.toISOString(),
      lastError: lastError
        ? { message: lastError.message, timestamp: lastError.timestamp.toISOString() }
        : undefined,
    }
  }

  /**
   * List all pools with info
   */
  listPoolsInfo(): PoolInfo[] {
    const result: PoolInfo[] = []
    for (const poolId of this.pools.keys()) {
      const info = this.getPoolInfo(poolId)
      if (info) result.push(info)
    }
    return result
  }

  /**
   * Get container info for API responses.
   * Direct DB lookup — O(1) instead of scanning all pools.
   */
  getContainerInfo(containerId: ContainerId): ContainerInfo | undefined {
    const row = this.db
      .select()
      .from(schema.containers)
      .where(eq(schema.containers.containerId, containerId))
      .get()
    if (!row) return undefined

    const pool = this.pools.get(row.poolId)
    if (!pool) return undefined

    const workload = pool.getWorkload()
    return {
      id: containerId,
      poolId: row.poolId,
      tenantId: row.tenantId,
      status: row.status as ContainerStatus,
      workloadId: workload.id,
      workloadName: workload.name,
      image: workload.image,
      createdAt: row.lastActivity.toISOString(),
      lastActivityAt: row.lastActivity.toISOString(),
      idleExpiresAt: row.idleExpiresAt?.toISOString() ?? null,
    }
  }

  /**
   * List all containers with info (idle, claimed, and affinity-reserved).
   */
  listContainersInfo(poolId?: PoolId): ContainerInfo[] {
    const result: ContainerInfo[] = []

    if (poolId) {
      const pool = this.pools.get(poolId)
      if (!pool) return result
      const workload = pool.getWorkload()

      for (const container of pool.getAllContainers()) {
        result.push({
          id: container.containerId,
          poolId,
          tenantId: container.tenantId,
          status: container.status,
          workloadId: workload.id,
          workloadName: workload.name,
          image: workload.image,
          createdAt: container.lastActivity.toISOString(),
          lastActivityAt: container.lastActivity.toISOString(),
          idleExpiresAt: container.idleExpiresAt?.toISOString() ?? null,
        })
      }
    } else {
      for (const pId of this.pools.keys()) {
        result.push(...this.listContainersInfo(pId))
      }
    }

    return result
  }

  /**
   * Destroy a container by ID.
   * DB lookup to find the pool — O(1) instead of scanning all pools.
   */
  async destroyContainer(containerId: ContainerId): Promise<boolean> {
    const row = this.db
      .select({ poolId: schema.containers.poolId })
      .from(schema.containers)
      .where(eq(schema.containers.containerId, containerId))
      .get()
    if (!row) return false

    const pool = this.pools.get(row.poolId)
    if (!pool) return false

    return pool.destroyContainer(containerId)
  }

  /**
   * Get pool by tenant ID.
   * Direct DB lookup — O(1) instead of scanning all pools.
   */
  getPoolForTenant(tenantId: TenantId): ContainerPool | undefined {
    const row = this.db
      .select({ poolId: schema.containers.poolId })
      .from(schema.containers)
      .where(and(eq(schema.containers.tenantId, tenantId), eq(schema.containers.status, 'claimed')))
      .get()
    if (!row) return undefined

    return this.pools.get(row.poolId)
  }

  /**
   * Get container for a tenant.
   * Direct DB lookup — O(1) instead of scanning all pools.
   */
  getContainerForTenant(tenantId: TenantId): PoolContainer | null {
    const row = this.db
      .select()
      .from(schema.containers)
      .where(and(eq(schema.containers.tenantId, tenantId), eq(schema.containers.status, 'claimed')))
      .get()
    if (!row) return null

    const pool = this.pools.get(row.poolId)
    if (!pool) return null

    // Use pool's toPoolContainer-equivalent to get computed paths
    return pool.getContainerForTenant(tenantId) ?? null
  }

  /**
   * Get aggregated stats
   */
  getStats(): {
    totalPools: number
    totalContainers: number
    activeContainers: number
    idleContainers: number
    totalTenants: number
  } {
    let totalContainers = 0
    let activeContainers = 0
    let idleContainers = 0
    let totalTenants = 0

    for (const pool of this.pools.values()) {
      const stats = pool.getStats()
      totalContainers += stats.size
      activeContainers += stats.borrowed
      idleContainers += stats.available
      totalTenants += pool.getTenantsWithClaims().length
    }

    return {
      totalPools: this.pools.size,
      totalContainers,
      activeContainers,
      idleContainers,
      totalTenants,
    }
  }

  /**
   * Destroy a pool
   */
  async destroyPool(poolId: PoolId): Promise<void> {
    const pool = this.pools.get(poolId)
    if (!pool) {
      throw new PoolNotFoundError(poolId)
    }

    await pool.drain()
    this.pools.delete(poolId)
    this.db.delete(schema.pools).where(eq(schema.pools.poolId, poolId)).run()
  }

  /**
   * Gracefully shutdown all pools.
   *
   * Stops pools without destroying containers so they can be recovered on restart.
   */
  shutdown(): void {
    for (const pool of this.pools.values()) {
      pool.stop()
    }
    this.pools.clear()
  }
}
