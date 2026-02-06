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
  ContainerStatus,
  PoolContainer,
  PoolId,
  TenantId,
  WorkloadId,
  WorkloadSpec,
} from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { eq } from 'drizzle-orm'
import { type ActivityLog, logPoolCreated, logPoolScaled } from '../activity'
import type { ContainerManager } from '../container/manager'
import { ContainerPool, type PoolStats } from '../container/pool'
import type { WorkloadRegistry } from '../workload'

/**
 * Extended pool information for API responses.
 */
export interface PoolInfo {
  /**
   * Unique identifier for this pool.
   * @example 'prod-workers'
   */
  id: PoolId

  /**
   * ID of the workload this pool runs.
   * @example 'python-worker'
   */
  workloadId: WorkloadId

  /**
   * Human-readable name of the workload.
   * @example 'Python ML Worker'
   */
  workloadName: string

  /**
   * Docker image used by containers in this pool.
   * @example 'myregistry/python-worker:latest'
   */
  image: string

  /** Minimum number of idle containers to maintain. */
  minIdle: number

  /** Maximum total containers allowed in this pool. */
  maxSize: number

  /** Current number of containers in the pool (idle + claimed). */
  currentSize: number

  /** Number of containers currently claimed by tenants. */
  claimedCount: number

  /** Number of containers available for claiming. */
  idleCount: number

  /**
   * Health status of the pool.
   * - `healthy`: Pool is operating normally
   * - `degraded`: Pool is at capacity or low on idle containers
   * - `error`: Pool has no containers or is failing
   * @example 'healthy'
   */
  status: 'healthy' | 'degraded' | 'error'

  /**
   * ISO 8601 timestamp when the pool was created.
   * @example '2024-01-15T10:00:00.000Z'
   */
  createdAt: string

  /**
   * Last error that occurred in this pool (if any).
   */
  lastError?: {
    message: string
    timestamp: string
  }
}

/**
 * Extended container information for API responses.
 */
export interface ContainerInfo {
  /**
   * Unique identifier for this container.
   * @example 'ml7wk37p-vbjcpb5g'
   */
  id: ContainerId

  /**
   * ID of the pool this container belongs to.
   * @example 'prod-workers'
   */
  poolId: PoolId

  /**
   * ID of the tenant that claimed this container, or null if idle.
   * @example 'tenant-12345'
   */
  tenantId: TenantId | null

  /**
   * Current lifecycle status of the container.
   * @example 'claimed'
   */
  status: ContainerStatus

  /**
   * ID of the workload this container runs.
   * @example 'python-worker'
   */
  workloadId: WorkloadId

  /**
   * Human-readable name of the workload.
   * @example 'Python ML Worker'
   */
  workloadName: string

  /**
   * Docker image this container is running.
   * @example 'myregistry/python-worker:latest'
   */
  image: string

  /**
   * ISO 8601 timestamp when the container was created.
   * @example '2024-02-05T08:00:00.000Z'
   */
  createdAt: string

  /**
   * ISO 8601 timestamp of the last activity on this container.
   * @example '2024-02-05T11:30:00.000Z'
   */
  lastActivityAt: string

  /**
   * ISO 8601 timestamp when this idle container will be evicted, or null.
   */
  idleExpiresAt: string | null
}

/**
 * Pool registry for managing multiple pools
 */
export class PoolRegistry {
  private pools: Map<PoolId, ContainerPool> = new Map()
  private manager: ContainerManager
  private workloadRegistry: WorkloadRegistry
  private activityLog: ActivityLog
  private db: DrizzleDb

  constructor(
    manager: ContainerManager,
    workloadRegistry: WorkloadRegistry,
    activityLog: ActivityLog,
    db: DrizzleDb,
  ) {
    this.manager = manager
    this.workloadRegistry = workloadRegistry
    this.activityLog = activityLog
    this.db = db
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
        console.log(
          `[PoolRegistry] Skipping pool ${record.poolId}: workload ${record.workloadId} not found`,
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
      )

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
      throw new Error(`Workload ${workloadId} not found`)
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
    )

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
   * Looks up the container across all pools.
   */
  getContainerInfo(containerId: ContainerId): ContainerInfo | undefined {
    for (const [poolId, pool] of this.pools) {
      const containers = pool.getAllContainers()
      const container = containers.find((c) => c.containerId === containerId)
      if (!container) continue

      const workload = pool.getWorkload()
      return {
        id: containerId,
        poolId,
        tenantId: container.tenantId,
        status: container.status,
        workloadId: workload.id,
        workloadName: workload.name,
        image: workload.image,
        createdAt: container.lastActivity.toISOString(),
        lastActivityAt: container.lastActivity.toISOString(),
        idleExpiresAt: container.idleExpiresAt?.toISOString() ?? null,
      }
    }

    return undefined
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
   * Destroy a container by ID
   */
  async destroyContainer(containerId: ContainerId): Promise<boolean> {
    for (const pool of this.pools.values()) {
      const destroyed = await pool.destroyContainer(containerId)
      if (destroyed) return true
    }
    return false
  }

  /**
   * Get pool by tenant ID (find which pool has this tenant)
   */
  getPoolForTenant(tenantId: TenantId): ContainerPool | undefined {
    for (const pool of this.pools.values()) {
      if (pool.hasTenant(tenantId)) {
        return pool
      }
    }
    return undefined
  }

  /**
   * Get container for a tenant (searches all pools)
   */
  getContainerForTenant(tenantId: TenantId): PoolContainer | null {
    for (const pool of this.pools.values()) {
      const container = pool.getContainerForTenant(tenantId)
      if (container) return container
    }
    return null
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
      throw new Error(`Pool ${poolId} not found`)
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
