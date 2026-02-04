/**
 * Container Pool
 *
 * Manages a pool of pre-warmed containers using generic-pool.
 * Provides fast container acquisition by maintaining idle containers ready for assignment.
 */

import type { PoolContainer, PoolId, TenantId, WorkloadSpec } from '@boilerhouse/core'
import { type Factory, type Pool, createPool } from 'generic-pool'
import { config } from '../config'
import type { ContainerManager } from './manager'

export interface ContainerPoolConfig {
  /** Workload specification for containers in this pool */
  workload: WorkloadSpec

  /** Unique identifier for this pool */
  poolId: PoolId

  /** Minimum number of idle containers to maintain */
  minSize: number

  /** Maximum total containers in this pool */
  maxSize: number

  /** Time in milliseconds before an idle container is evicted */
  idleTimeoutMs: number

  /** Interval for running eviction checks */
  evictionIntervalMs: number

  /** Maximum time to wait when acquiring a container */
  acquireTimeoutMs: number

  /** Optional network name override */
  networkName?: string
}

export interface PoolStats {
  size: number
  available: number
  borrowed: number
  pending: number
  min: number
  max: number
}

export class ContainerPool {
  private manager: ContainerManager
  private pool: Pool<PoolContainer>
  private poolConfig: ContainerPoolConfig
  private assignedContainers: Map<TenantId, PoolContainer> = new Map()

  constructor(
    manager: ContainerManager,
    poolConfig: Pick<ContainerPoolConfig, 'workload' | 'poolId'> & Partial<ContainerPoolConfig>,
  ) {
    this.manager = manager
    this.poolConfig = {
      workload: poolConfig.workload,
      poolId: poolConfig.poolId,
      minSize: poolConfig.minSize ?? config.pool.minPoolSize,
      maxSize: poolConfig.maxSize ?? config.pool.maxContainersPerNode,
      idleTimeoutMs: poolConfig.idleTimeoutMs ?? config.pool.containerIdleTimeoutMs,
      evictionIntervalMs: poolConfig.evictionIntervalMs ?? 30000,
      acquireTimeoutMs: poolConfig.acquireTimeoutMs ?? config.pool.containerStartTimeoutMs,
      networkName: poolConfig.networkName,
    }

    const factory: Factory<PoolContainer> = {
      create: async () => {
        console.log('[Pool] Creating new container')
        const container = await this.manager.createContainer(
          this.poolConfig.workload,
          this.poolConfig.poolId,
          this.poolConfig.networkName,
        )
        console.log(`[Pool] Created container ${container.containerId}`)
        return container
      },

      destroy: async (container) => {
        console.log(`[Pool] Destroying container ${container.containerId}`)
        await this.manager.destroyContainer(container.containerId)
        console.log(`[Pool] Destroyed container ${container.containerId}`)
      },

      validate: async (container) => {
        const healthy = await this.manager.isHealthy(container.containerId)
        if (!healthy) {
          console.log(`[Pool] Container ${container.containerId} failed health check`)
        }
        return healthy
      },
    }

    this.pool = createPool(factory, {
      min: this.poolConfig.minSize,
      max: this.poolConfig.maxSize,
      acquireTimeoutMillis: this.poolConfig.acquireTimeoutMs,
      idleTimeoutMillis: this.poolConfig.idleTimeoutMs,
      evictionRunIntervalMillis: this.poolConfig.evictionIntervalMs,
      testOnBorrow: true,
      autostart: true,
    })

    // Log pool events
    this.pool.on('factoryCreateError', (err) => {
      console.error('[Pool] Factory create error:', err)
    })

    this.pool.on('factoryDestroyError', (err) => {
      console.error('[Pool] Factory destroy error:', err)
    })
  }

  /**
   * Acquire a container for a tenant
   *
   * If the tenant already has an assigned container, returns it.
   * Otherwise, acquires one from the pool and assigns it.
   */
  async acquireForTenant(tenantId: TenantId): Promise<PoolContainer> {
    // Check if tenant already has an assigned container
    const existing = this.assignedContainers.get(tenantId)
    if (existing) {
      this.manager.recordActivity(existing.containerId)
      return existing
    }

    // Acquire from pool
    const container = await this.pool.acquire()

    // Assign to tenant
    await this.manager.assignToTenant(container.containerId, tenantId)

    this.assignedContainers.set(tenantId, container)
    console.log(`[Pool] Assigned container ${container.containerId} to tenant ${tenantId}`)

    return container
  }

  /**
   * Release a tenant's container back to the pool
   *
   * Wipes tenant data and returns container to pool for reuse.
   */
  async releaseForTenant(tenantId: TenantId): Promise<void> {
    const container = this.assignedContainers.get(tenantId)
    if (!container) {
      console.log(`[Pool] No container found for tenant ${tenantId}`)
      return
    }

    this.assignedContainers.delete(tenantId)

    // Release from tenant assignment (wipes data)
    await this.manager.releaseContainer(container.containerId)

    // Return to pool
    await this.pool.release(container)
    console.log(`[Pool] Released container ${container.containerId} from tenant ${tenantId}`)
  }

  /**
   * Destroy a tenant's container completely
   *
   * Removes from pool and destroys. Use for problematic containers.
   */
  async destroyForTenant(tenantId: TenantId): Promise<void> {
    const container = this.assignedContainers.get(tenantId)
    if (!container) {
      return
    }

    this.assignedContainers.delete(tenantId)

    // Destroy the container (removes from pool)
    await this.pool.destroy(container)
    console.log(`[Pool] Destroyed container ${container.containerId} for tenant ${tenantId}`)
  }

  /**
   * Get container for a tenant (if assigned)
   */
  getContainerForTenant(tenantId: TenantId): PoolContainer | undefined {
    return this.assignedContainers.get(tenantId)
  }

  /**
   * Check if tenant has an assigned container
   */
  hasTenant(tenantId: TenantId): boolean {
    return this.assignedContainers.has(tenantId)
  }

  /**
   * Record activity for a tenant's container
   */
  recordActivity(tenantId: TenantId): void {
    const container = this.assignedContainers.get(tenantId)
    if (container) {
      this.manager.recordActivity(container.containerId)
    }
  }

  /**
   * Evict stale containers (idle too long)
   */
  async evictStale(): Promise<number> {
    const staleContainers = this.manager.getStaleContainers(this.poolConfig.idleTimeoutMs)
    let evicted = 0

    for (const container of staleContainers) {
      if (container.tenantId) {
        console.log(
          `[Pool] Evicting stale container ${container.containerId} for tenant ${container.tenantId}`,
        )
        await this.releaseForTenant(container.tenantId)
        evicted++
      }
    }

    return evicted
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    return {
      size: this.pool.size,
      available: this.pool.available,
      borrowed: this.pool.borrowed,
      pending: this.pool.pending,
      min: this.pool.min,
      max: this.pool.max,
    }
  }

  /**
   * Get the pool ID
   */
  getPoolId(): PoolId {
    return this.poolConfig.poolId
  }

  /**
   * Get the workload spec for this pool
   */
  getWorkload(): WorkloadSpec {
    return this.poolConfig.workload
  }

  /**
   * Get all assigned tenant IDs
   */
  getAssignedTenants(): TenantId[] {
    return Array.from(this.assignedContainers.keys())
  }

  /**
   * Gracefully drain the pool
   *
   * Releases all containers and waits for pool to drain.
   */
  async drain(): Promise<void> {
    console.log('[Pool] Draining pool...')

    // Release all assigned containers
    const tenants = Array.from(this.assignedContainers.keys())
    await Promise.all(tenants.map((tenantId) => this.releaseForTenant(tenantId)))

    // Drain and clear the pool
    await this.pool.drain()
    await this.pool.clear()

    console.log('[Pool] Pool drained')
  }

  /**
   * Start periodic stale container eviction
   */
  startEvictionLoop(intervalMs?: number): NodeJS.Timeout {
    const interval = intervalMs ?? this.poolConfig.evictionIntervalMs
    return setInterval(async () => {
      try {
        const evicted = await this.evictStale()
        if (evicted > 0) {
          console.log(`[Pool] Evicted ${evicted} stale containers`)
        }
      } catch (err) {
        console.error('[Pool] Eviction error:', err)
      }
    }, interval)
  }
}
