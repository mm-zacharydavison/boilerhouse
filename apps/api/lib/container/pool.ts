/**
 * Container Pool
 *
 * Manages a pool of pre-warmed containers using generic-pool.
 * Provides fast container acquisition by maintaining idle containers ready for assignment.
 */

import type { PoolContainer, PoolId, TenantId, WorkloadSpec } from '@boilerhouse/core'
import type { AffinityRepository } from '@boilerhouse/db'
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

  /** Time to keep a released container reserved for the same tenant before returning to pool */
  affinityTimeoutMs: number
}

export interface PoolStats {
  size: number
  available: number
  borrowed: number
  pending: number
  min: number
  max: number
}

export interface PoolError {
  message: string
  timestamp: Date
}

/** Result of acquiring a container, includes affinity match info */
export interface AcquireResult {
  container: PoolContainer
  /** True if this tenant is returning to their previous container (state intact) */
  isAffinityMatch: boolean
}

export class ContainerPool {
  private manager: ContainerManager
  private pool: Pool<PoolContainer>
  private poolConfig: ContainerPoolConfig
  private assignedContainers: Map<TenantId, PoolContainer> = new Map()
  /** Track all containers by ID so we can destroy specific ones */
  private allContainers: Map<string, PoolContainer> = new Map()
  /** Containers reserved for returning tenants (not in generic-pool) */
  private affinityContainers: Map<TenantId, PoolContainer> = new Map()
  /** Timeouts to return affinity containers to pool */
  private affinityTimeouts: Map<TenantId, ReturnType<typeof setTimeout>> = new Map()
  private _lastError: PoolError | null = null
  private affinityRepo?: AffinityRepository

  constructor(
    manager: ContainerManager,
    poolConfig: Pick<ContainerPoolConfig, 'workload' | 'poolId'> & Partial<ContainerPoolConfig>,
    affinityRepo?: AffinityRepository,
  ) {
    this.manager = manager
    this.affinityRepo = affinityRepo
    this.poolConfig = {
      workload: poolConfig.workload,
      poolId: poolConfig.poolId,
      minSize: poolConfig.minSize ?? config.pool.minPoolSize,
      maxSize: poolConfig.maxSize ?? config.pool.maxContainersPerNode,
      idleTimeoutMs: poolConfig.idleTimeoutMs ?? config.pool.containerIdleTimeoutMs,
      evictionIntervalMs: poolConfig.evictionIntervalMs ?? 30000,
      acquireTimeoutMs: poolConfig.acquireTimeoutMs ?? config.pool.containerStartTimeoutMs,
      networkName: poolConfig.networkName,
      affinityTimeoutMs: poolConfig.affinityTimeoutMs ?? 0 * 60 * 1000, // 0 minutes default
    }

    const factory: Factory<PoolContainer> = {
      create: async () => {
        console.log('[Pool] Creating new container')
        try {
          const container = await this.manager.createContainer(
            this.poolConfig.workload,
            this.poolConfig.poolId,
            this.poolConfig.networkName,
          )
          console.log(`[Pool] Created container ${container.containerId}`)
          this._lastError = null
          // Track container for later lookup
          this.allContainers.set(container.containerId, container)
          return container
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[Pool] Failed to create container: ${message}`)
          this._lastError = { message, timestamp: new Date() }
          throw err
        }
      },

      destroy: async (container) => {
        console.log(`[Pool] Destroying container ${container.containerId}`)
        await this.manager.destroyContainer(container.containerId)
        // Remove from tracking
        this.allContainers.delete(container.containerId)
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
   * Priority:
   * 1. If tenant already has an assigned container, returns it
   * 2. If tenant has an affinity container (their previous container), returns it
   * 3. Otherwise, acquires from pool
   *
   * Returns isAffinityMatch=true if returning tenant's previous container (state intact).
   */
  async acquireForTenant(tenantId: TenantId): Promise<AcquireResult> {
    // Check if tenant already has an assigned container
    const existing = this.assignedContainers.get(tenantId)
    if (existing) {
      this.manager.recordActivity(existing.containerId)
      return { container: existing, isAffinityMatch: true }
    }

    // Check for affinity container (tenant's previous container reserved for them)
    const affinityContainer = this.affinityContainers.get(tenantId)
    if (affinityContainer) {
      // Clear the timeout and remove from affinity map
      const timeout = this.affinityTimeouts.get(tenantId)
      if (timeout) {
        clearTimeout(timeout)
        this.affinityTimeouts.delete(tenantId)
      }
      this.affinityContainers.delete(tenantId)
      this.affinityRepo?.delete(tenantId)

      // Validate container is still healthy
      const healthy = await this.manager.isHealthy(affinityContainer.containerId)
      if (healthy) {
        // Assign to tenant
        await this.manager.assignToTenant(affinityContainer.containerId, tenantId)
        this.assignedContainers.set(tenantId, affinityContainer)
        console.log(
          `[Pool] Returned affinity container ${affinityContainer.containerId} to tenant ${tenantId}`,
        )
        return { container: affinityContainer, isAffinityMatch: true }
      }

      // Container unhealthy, destroy it and fall through to pool
      console.log(
        `[Pool] Affinity container ${affinityContainer.containerId} unhealthy, destroying`,
      )
      await this.manager.destroyContainer(affinityContainer.containerId)
      this.allContainers.delete(affinityContainer.containerId)
    }

    // Acquire from pool
    const container = await this.pool.acquire()

    // Assign to tenant
    await this.manager.assignToTenant(container.containerId, tenantId)

    this.assignedContainers.set(tenantId, container)
    console.log(`[Pool] Assigned container ${container.containerId} to tenant ${tenantId}`)

    return { container, isAffinityMatch: false }
  }

  /**
   * Release a tenant's container
   *
   * Instead of returning to pool immediately, keeps container reserved for the
   * tenant in case they return soon. After affinityTimeoutMs, container is
   * wiped and returned to pool for other tenants.
   */
  async releaseForTenant(tenantId: TenantId): Promise<void> {
    const container = this.assignedContainers.get(tenantId)
    if (!container) {
      console.log(`[Pool] No container found for tenant ${tenantId}`)
      return
    }

    this.assignedContainers.delete(tenantId)

    // Release from tenant assignment (preserves lastTenantId for affinity)
    await this.manager.releaseContainer(container.containerId)

    // Clear any existing affinity for this tenant (shouldn't happen, but be safe)
    const existingTimeout = this.affinityTimeouts.get(tenantId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    const existingAffinity = this.affinityContainers.get(tenantId)
    if (existingAffinity) {
      // Return the old affinity container to pool with wipe
      await this.flushAffinityToPool(existingAffinity)
    }

    // Store in affinity map for potential quick return
    this.affinityContainers.set(tenantId, container)

    // Persist affinity reservation
    const expiresAt = new Date(Date.now() + this.poolConfig.affinityTimeoutMs)
    this.affinityRepo?.save({
      tenantId,
      containerId: container.containerId,
      poolId: this.poolConfig.poolId,
      expiresAt,
    })

    // Set timeout to return to pool if tenant doesn't come back
    const timeout = setTimeout(async () => {
      this.affinityTimeouts.delete(tenantId)
      this.affinityRepo?.delete(tenantId)
      const affinityContainer = this.affinityContainers.get(tenantId)
      if (affinityContainer && affinityContainer.containerId === container.containerId) {
        this.affinityContainers.delete(tenantId)
        await this.flushAffinityToPool(affinityContainer)
      }
    }, this.poolConfig.affinityTimeoutMs)

    this.affinityTimeouts.set(tenantId, timeout)

    console.log(
      `[Pool] Released container ${container.containerId} from tenant ${tenantId} (reserved for ${this.poolConfig.affinityTimeoutMs}ms)`,
    )
  }

  /**
   * Wipe an affinity container and return it to the pool
   */
  private async flushAffinityToPool(container: PoolContainer): Promise<void> {
    try {
      // Wipe state for next tenant
      await this.manager.wipeForNewTenant(container.containerId)
      // Return to pool
      await this.pool.release(container)
      console.log(`[Pool] Flushed affinity container ${container.containerId} back to pool`)
    } catch (err) {
      console.error(`[Pool] Failed to flush affinity container ${container.containerId}:`, err)
      // Try to destroy it since we couldn't return it cleanly
      try {
        await this.manager.destroyContainer(container.containerId)
        this.allContainers.delete(container.containerId)
      } catch {
        // Best effort
      }
    }
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
   * Destroy a container by ID
   *
   * Works for both assigned and idle containers.
   * Uses pool.destroy() so the pool knows to create a replacement.
   */
  async destroyContainer(containerId: string): Promise<boolean> {
    // Check if it's assigned to a tenant
    for (const [tenantId, container] of this.assignedContainers) {
      if (container.containerId === containerId) {
        await this.destroyForTenant(tenantId)
        return true
      }
    }

    // Look up the container in our tracking map
    const container = this.allContainers.get(containerId)
    if (!container) {
      return false
    }

    // Use pool.destroy() so the pool creates a replacement
    await this.pool.destroy(container)
    console.log(`[Pool] Destroyed idle container ${containerId}`)
    return true
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
   * Scale the pool to a target size.
   *
   * - Scale up: Creates new containers by acquiring and releasing
   * - Scale down: Destroys idle containers (assigned containers are preserved)
   *
   * @param targetSize - Desired number of total containers
   * @returns Object with actual new size and any errors
   */
  async scaleTo(targetSize: number): Promise<{ newSize: number; message: string }> {
    if (targetSize < 0) {
      throw new Error('Target size cannot be negative')
    }

    if (targetSize > this.poolConfig.maxSize) {
      throw new Error(`Cannot scale above max size ${this.poolConfig.maxSize}`)
    }

    const currentSize = this.pool.size
    const assignedCount = this.assignedContainers.size

    if (targetSize === currentSize) {
      return { newSize: currentSize, message: 'Already at target size' }
    }

    if (targetSize > currentSize) {
      // Scale up: first hold all idle containers, then acquire more to force creation
      const toCreate = targetSize - currentSize
      const tempContainers: PoolContainer[] = []

      console.log(`[Pool] Scaling up: creating ${toCreate} containers`)

      // First, acquire all currently idle containers to hold them
      const idleCount = this.pool.available
      for (let i = 0; i < idleCount; i++) {
        try {
          const container = await this.pool.acquire()
          tempContainers.push(container)
        } catch {
          break
        }
      }

      // Now acquire more - this will force creation since no idle containers exist
      for (let i = 0; i < toCreate; i++) {
        try {
          const container = await this.pool.acquire()
          tempContainers.push(container)
        } catch (err) {
          console.error('[Pool] Failed to create container during scale up:', err)
          break
        }
      }

      // Release them all back to idle
      for (const container of tempContainers) {
        await this.pool.release(container)
      }

      const newSize = this.pool.size
      console.log(`[Pool] Scale up complete: ${currentSize} -> ${newSize}`)
      return { newSize, message: `Scaled up from ${currentSize} to ${newSize}` }
    }

    // Scale down: destroy idle containers
    if (targetSize < assignedCount) {
      // Can't scale below assigned count
      const minPossible = assignedCount
      console.log(
        `[Pool] Cannot scale to ${targetSize}, ${assignedCount} containers are assigned. Min possible: ${minPossible}`,
      )
      return {
        newSize: currentSize,
        message: `Cannot scale below ${assignedCount} assigned containers`,
      }
    }

    const toDestroy = currentSize - targetSize
    let destroyed = 0

    console.log(`[Pool] Scaling down: destroying ${toDestroy} idle containers`)

    // Destroy idle containers
    while (destroyed < toDestroy && this.pool.available > 0) {
      try {
        const container = await this.pool.acquire()
        await this.pool.destroy(container)
        destroyed++
      } catch (err) {
        console.error('[Pool] Failed to destroy container during scale down:', err)
        break
      }
    }

    const newSize = this.pool.size
    console.log(`[Pool] Scale down complete: ${currentSize} -> ${newSize}`)
    return { newSize, message: `Scaled down from ${currentSize} to ${newSize}` }
  }

  /**
   * Get the pool ID
   */
  getPoolId(): PoolId {
    return this.poolConfig.poolId
  }

  /**
   * Get the last error that occurred in this pool
   */
  getLastError(): PoolError | null {
    return this._lastError
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
   * Stop the pool without destroying containers.
   *
   * Clears timers and in-memory state but leaves Docker containers running.
   * Use this for graceful shutdown when you want to recover state on restart.
   */
  stop(): void {
    console.log('[Pool] Stopping pool (preserving containers)...')

    // Clear all affinity timeouts (just the timers)
    for (const timeout of this.affinityTimeouts.values()) {
      clearTimeout(timeout)
    }
    this.affinityTimeouts.clear()

    console.log('[Pool] Pool stopped')
  }

  /**
   * Gracefully drain the pool
   *
   * Releases all containers and waits for pool to drain.
   * Use this for permanent shutdown when containers should be destroyed.
   */
  async drain(): Promise<void> {
    console.log('[Pool] Draining pool...')

    // First, release all assigned containers (this moves them to affinity)
    const tenants = Array.from(this.assignedContainers.keys())
    for (const tenantId of tenants) {
      const container = this.assignedContainers.get(tenantId)
      if (container) {
        this.assignedContainers.delete(tenantId)
        await this.manager.releaseContainer(container.containerId)
        // Put directly in affinity for cleanup below
        this.affinityContainers.set(tenantId, container)
      }
    }

    // Clear all affinity timeouts
    for (const timeout of this.affinityTimeouts.values()) {
      clearTimeout(timeout)
    }
    this.affinityTimeouts.clear()

    // Flush all affinity containers back to pool
    for (const container of this.affinityContainers.values()) {
      try {
        await this.manager.wipeForNewTenant(container.containerId)
        await this.pool.release(container)
      } catch {
        // Best effort during drain
      }
    }
    this.affinityContainers.clear()

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

  /**
   * Restore an affinity reservation from the database.
   * Used during recovery to re-establish affinity timeouts.
   */
  restoreAffinity(tenantId: TenantId, container: PoolContainer, remainingMs: number): void {
    if (remainingMs <= 0) {
      // Already expired, flush to pool
      this.flushAffinityToPool(container).catch((err) => {
        console.error(`[Pool] Failed to flush expired affinity for ${tenantId}:`, err)
      })
      return
    }

    this.affinityContainers.set(tenantId, container)
    this.allContainers.set(container.containerId, container)

    const timeout = setTimeout(async () => {
      this.affinityTimeouts.delete(tenantId)
      this.affinityRepo?.delete(tenantId)
      const affinityContainer = this.affinityContainers.get(tenantId)
      if (affinityContainer && affinityContainer.containerId === container.containerId) {
        this.affinityContainers.delete(tenantId)
        await this.flushAffinityToPool(affinityContainer)
      }
    }, remainingMs)

    this.affinityTimeouts.set(tenantId, timeout)
    console.log(
      `[Pool] Restored affinity for tenant ${tenantId}, container ${container.containerId}, expires in ${remainingMs}ms`,
    )
  }

  /**
   * Restore an assigned container from recovery.
   * Used to add containers that were assigned at crash time back to tracking.
   */
  restoreAssigned(tenantId: TenantId, container: PoolContainer): void {
    this.assignedContainers.set(tenantId, container)
    this.allContainers.set(container.containerId, container)
    console.log(
      `[Pool] Restored assigned container ${container.containerId} for tenant ${tenantId}`,
    )
  }

  /**
   * Restore an idle container from recovery.
   * Used to add containers that were idle at crash time back to the pool.
   */
  async restoreIdle(container: PoolContainer): Promise<void> {
    this.allContainers.set(container.containerId, container)
    // The container is already in the manager, we just need to track it
    // Note: generic-pool doesn't have a method to add existing resources,
    // so we'll just track it in allContainers for now
    console.log(`[Pool] Restored idle container ${container.containerId}`)
  }
}
