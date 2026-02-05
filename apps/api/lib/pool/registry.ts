/**
 * Pool Registry
 *
 * Manages multiple container pools, each associated with a workload.
 * Provides centralized access to pools and their containers.
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
import type { AffinityRepository } from '@boilerhouse/db'
import { type ActivityLog, getActivityLog, logPoolCreated, logPoolScaled } from '../activity'
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
  minSize: number

  /** Maximum total containers allowed in this pool. */
  maxSize: number

  /** Current number of containers in the pool (idle + claimed). */
  currentSize: number

  /** Number of containers currently assigned to tenants. */
  claimedCount: number

  /** Number of containers available for assignment. */
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
   * ID of the tenant this container is assigned to, or null if idle.
   * @example 'tenant-12345'
   */
  tenantId: TenantId | null

  /**
   * Current lifecycle status of the container.
   * @example 'assigned'
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
}

/**
 * Pool registry for managing multiple pools
 */
export class PoolRegistry {
  private pools: Map<PoolId, ContainerPool> = new Map()
  private poolCreatedAt: Map<PoolId, Date> = new Map()
  private manager: ContainerManager
  private workloadRegistry: WorkloadRegistry
  private activityLog: ActivityLog
  private affinityRepo?: AffinityRepository

  constructor(
    manager: ContainerManager,
    workloadRegistry: WorkloadRegistry,
    activityLog?: ActivityLog,
    affinityRepo?: AffinityRepository,
  ) {
    this.manager = manager
    this.workloadRegistry = workloadRegistry
    this.activityLog = activityLog ?? getActivityLog()
    this.affinityRepo = affinityRepo
  }

  /**
   * Create a new pool for a workload
   */
  createPool(
    poolId: PoolId,
    workloadId: WorkloadId,
    config?: Partial<{
      minSize: number
      maxSize: number
      idleTimeoutMs: number
      networkName: string
    }>,
  ): ContainerPool {
    if (this.pools.has(poolId)) {
      throw new Error(`Pool ${poolId} already exists`)
    }

    const workload = this.workloadRegistry.get(workloadId)
    if (!workload) {
      throw new Error(`Workload ${workloadId} not found`)
    }

    const pool = new ContainerPool(
      this.manager,
      {
        workload,
        poolId,
        ...config,
      },
      this.affinityRepo,
    )

    this.pools.set(poolId, pool)
    this.poolCreatedAt.set(poolId, new Date())

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
    const createdAt = this.poolCreatedAt.get(poolId) ?? new Date()

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
      minSize: stats.min,
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
   * Get all containers across all pools
   */
  getAllContainers(): PoolContainer[] {
    return this.manager.getAllContainers()
  }

  /**
   * Get containers for a specific pool
   */
  getContainersForPool(poolId: PoolId): PoolContainer[] {
    return this.manager.getAllContainers().filter((c) => c.poolId === poolId)
  }

  /**
   * Get container info for API responses
   */
  getContainerInfo(containerId: ContainerId): ContainerInfo | undefined {
    const container = this.manager.getContainer(containerId)
    if (!container) return undefined

    const pool = this.pools.get(container.poolId)
    if (!pool) return undefined

    const workload = pool.getWorkload()

    return {
      id: container.containerId,
      poolId: container.poolId,
      tenantId: container.tenantId,
      status: container.status,
      workloadId: workload.id,
      workloadName: workload.name,
      image: workload.image,
      createdAt: container.lastActivity.toISOString(),
      lastActivityAt: container.lastActivity.toISOString(),
    }
  }

  /**
   * List all containers with info
   */
  listContainersInfo(poolId?: PoolId): ContainerInfo[] {
    const containers = poolId ? this.getContainersForPool(poolId) : this.getAllContainers()

    const result: ContainerInfo[] = []
    for (const container of containers) {
      const info = this.getContainerInfo(container.containerId)
      if (info) result.push(info)
    }
    return result
  }

  /**
   * Destroy a container by ID
   */
  async destroyContainer(containerId: ContainerId): Promise<boolean> {
    const container = this.manager.getContainer(containerId)
    if (!container) return false

    const pool = this.pools.get(container.poolId)
    if (!pool) return false

    return pool.destroyContainer(containerId)
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
   * Get container for a tenant
   */
  getContainerForTenant(tenantId: TenantId): PoolContainer | undefined {
    return this.manager.getContainerByTenant(tenantId)
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
      totalTenants += pool.getAssignedTenants().length
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
    this.poolCreatedAt.delete(poolId)
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
    this.poolCreatedAt.clear()
  }
}
