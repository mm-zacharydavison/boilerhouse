/**
 * Container Pool
 *
 * Manages a pool of pre-warmed containers using generic-pool.
 * Provides fast container acquisition by maintaining idle containers ready for claiming.
 *
 * Claim and affinity state stored in SQLite via Drizzle ORM.
 * allContainers is a runtime cache bridging generic-pool references.
 */

import type { ContainerId, PoolContainer, PoolId, TenantId, WorkloadSpec } from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { count, eq, gt, lte } from 'drizzle-orm'
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
  /** Track all containers by ID so we can destroy specific ones */
  private allContainers: Map<string, PoolContainer> = new Map()
  /** Timeouts to return affinity containers to pool */
  private affinityTimeouts: Map<TenantId, ReturnType<typeof setTimeout>> = new Map()
  private _lastError: PoolError | null = null
  private db: DrizzleDb

  constructor(
    manager: ContainerManager,
    poolConfig: Pick<ContainerPoolConfig, 'workload' | 'poolId'> & Partial<ContainerPoolConfig>,
    db: DrizzleDb,
  ) {
    this.manager = manager
    this.db = db
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
   * 1. If tenant already has a claimed container (from DB), returns it
   * 2. If tenant has an affinity container (their previous container), returns it
   * 3. Otherwise, acquires from pool
   *
   * Returns isAffinityMatch=true if returning tenant's previous container (state intact).
   */
  async acquireForTenant(tenantId: TenantId): Promise<AcquireResult> {
    // Check if tenant already has a claimed container (DB lookup)
    const existingClaim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.tenantId, tenantId))
      .get()
    if (existingClaim && existingClaim.poolId === this.poolConfig.poolId) {
      const existing = this.allContainers.get(existingClaim.containerId)
      if (existing) {
        this.manager.recordActivity(existing.containerId)
        return { container: existing, isAffinityMatch: true }
      }
    }

    // Check for affinity container (tenant's previous container reserved for them)
    const affinityReservation = this.db
      .select()
      .from(schema.affinityReservations)
      .where(eq(schema.affinityReservations.tenantId, tenantId))
      .get()
    if (affinityReservation && affinityReservation.poolId === this.poolConfig.poolId) {
      const affinityContainer = this.allContainers.get(affinityReservation.containerId)
      if (affinityContainer) {
        // Clear the timeout and remove from affinity
        const timeout = this.affinityTimeouts.get(tenantId)
        if (timeout) {
          clearTimeout(timeout)
          this.affinityTimeouts.delete(tenantId)
        }
        this.db
          .delete(schema.affinityReservations)
          .where(eq(schema.affinityReservations.tenantId, tenantId))
          .run()

        // Validate container is still healthy
        const healthy = await this.manager.isHealthy(affinityContainer.containerId)
        if (healthy) {
          // Claim for tenant
          await this.manager.claimForTenant(
            affinityContainer.containerId,
            tenantId,
            affinityContainer,
          )
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
      } else {
        // Container not in allContainers (maybe crashed), clean up DB
        this.db
          .delete(schema.affinityReservations)
          .where(eq(schema.affinityReservations.tenantId, tenantId))
          .run()
      }
    }

    // Acquire from pool
    const container = await this.pool.acquire()

    // Claim for tenant
    await this.manager.claimForTenant(container.containerId, tenantId, container)

    console.log(`[Pool] Claimed container ${container.containerId} for tenant ${tenantId}`)

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
    // Find container via claim DB
    const claim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.tenantId, tenantId))
      .get()
    if (!claim || claim.poolId !== this.poolConfig.poolId) {
      console.log(`[Pool] No container found for tenant ${tenantId}`)
      return
    }

    const container = this.allContainers.get(claim.containerId)
    if (!container) {
      console.log(
        `[Pool] Container ${claim.containerId} not in allContainers for tenant ${tenantId}`,
      )
      this.db.delete(schema.claims).where(eq(schema.claims.containerId, claim.containerId)).run()
      return
    }

    // Release from tenant claim (preserves lastTenantId for affinity)
    await this.manager.releaseContainer(container.containerId, container)

    // Clear any existing affinity for this tenant
    const existingTimeout = this.affinityTimeouts.get(tenantId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    const existingAffinity = this.db
      .select()
      .from(schema.affinityReservations)
      .where(eq(schema.affinityReservations.tenantId, tenantId))
      .get()
    if (existingAffinity) {
      const existingAffinityContainer = this.allContainers.get(existingAffinity.containerId)
      if (existingAffinityContainer) {
        await this.flushAffinityToPool(existingAffinityContainer)
      }
      this.db
        .delete(schema.affinityReservations)
        .where(eq(schema.affinityReservations.tenantId, tenantId))
        .run()
    }

    // Persist affinity reservation
    const expiresAt = new Date(Date.now() + this.poolConfig.affinityTimeoutMs)
    this.db
      .insert(schema.affinityReservations)
      .values({
        tenantId,
        containerId: container.containerId,
        poolId: this.poolConfig.poolId,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: schema.affinityReservations.tenantId,
        set: {
          containerId: container.containerId,
          poolId: this.poolConfig.poolId,
          expiresAt,
        },
      })
      .run()

    // Set timeout to return to pool if tenant doesn't come back
    const timeout = setTimeout(async () => {
      this.affinityTimeouts.delete(tenantId)
      this.db
        .delete(schema.affinityReservations)
        .where(eq(schema.affinityReservations.tenantId, tenantId))
        .run()
      // Look up the container from allContainers by the containerId we captured
      const affinityContainer = this.allContainers.get(container.containerId)
      if (affinityContainer) {
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
    // Find via claim DB
    const claim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.tenantId, tenantId))
      .get()
    if (!claim || claim.poolId !== this.poolConfig.poolId) {
      return
    }

    const container = this.allContainers.get(claim.containerId)
    if (!container) {
      this.db.delete(schema.claims).where(eq(schema.claims.containerId, claim.containerId)).run()
      return
    }

    // Destroy the container (removes from pool)
    await this.pool.destroy(container)
    console.log(`[Pool] Destroyed container ${container.containerId} for tenant ${tenantId}`)
  }

  /**
   * Destroy a container by ID
   *
   * Works for both claimed and idle containers.
   * Uses pool.destroy() so the pool knows to create a replacement.
   */
  async destroyContainer(containerId: string): Promise<boolean> {
    // Check if it's claimed by a tenant
    const claim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.containerId, containerId as ContainerId))
      .get()
    if (claim && claim.poolId === this.poolConfig.poolId) {
      await this.destroyForTenant(claim.tenantId)
      return true
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
   * Get container for a tenant (if claimed in this pool)
   */
  getContainerForTenant(tenantId: TenantId): PoolContainer | undefined {
    const claim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.tenantId, tenantId))
      .get()
    if (!claim || claim.poolId !== this.poolConfig.poolId) {
      return undefined
    }
    return this.allContainers.get(claim.containerId)
  }

  /**
   * Check if tenant has a claimed container in this pool
   */
  hasTenant(tenantId: TenantId): boolean {
    const claim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.tenantId, tenantId))
      .get()
    return claim !== undefined && claim.poolId === this.poolConfig.poolId
  }

  /**
   * Record activity for a tenant's container
   */
  recordActivity(tenantId: TenantId): void {
    const claim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.tenantId, tenantId))
      .get()
    if (claim && claim.poolId === this.poolConfig.poolId) {
      this.manager.recordActivity(claim.containerId)
    }
  }

  /**
   * Evict stale containers (idle too long)
   */
  async evictStale(): Promise<number> {
    const staleContainers = this.manager.getStaleContainers(this.poolConfig.idleTimeoutMs)
    let evicted = 0

    for (const stale of staleContainers) {
      const claim = this.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.containerId, stale.containerId))
        .get()
      if (claim && claim.poolId === this.poolConfig.poolId) {
        console.log(
          `[Pool] Evicting stale container ${stale.containerId} for tenant ${stale.tenantId}`,
        )
        await this.releaseForTenant(stale.tenantId)
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
   * - Scale down: Destroys idle containers (claimed containers are preserved)
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
    const result = this.db
      .select({ count: count() })
      .from(schema.claims)
      .where(eq(schema.claims.poolId, this.poolConfig.poolId))
      .get()
    const claimedCount = result?.count ?? 0

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
    if (targetSize < claimedCount) {
      // Can't scale below claimed count
      console.log(
        `[Pool] Cannot scale to ${targetSize}, ${claimedCount} containers are claimed. Min possible: ${claimedCount}`,
      )
      return {
        newSize: currentSize,
        message: `Cannot scale below ${claimedCount} claimed containers`,
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
   * Get all containers in this pool (idle, claimed, and affinity-reserved).
   * Returns the runtime cache of PoolContainer objects.
   */
  getAllContainers(): PoolContainer[] {
    return Array.from(this.allContainers.values())
  }

  /**
   * Get all claimed tenant IDs in this pool
   */
  getTenantsWithClaims(): TenantId[] {
    return this.db
      .select({ tenantId: schema.claims.tenantId })
      .from(schema.claims)
      .where(eq(schema.claims.poolId, this.poolConfig.poolId))
      .all()
      .map((c) => c.tenantId)
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

    // Release all claimed containers back to the pool
    const poolClaims = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.poolId, this.poolConfig.poolId))
      .all()
    for (const claim of poolClaims) {
      const container = this.allContainers.get(claim.containerId)
      if (container) {
        await this.manager.releaseContainer(container.containerId, container)
        await this.pool.release(container)
      }
    }

    // Clear all affinity timeouts
    for (const timeout of this.affinityTimeouts.values()) {
      clearTimeout(timeout)
    }
    this.affinityTimeouts.clear()

    // Flush all affinity containers back to pool
    const affinityRows = this.db
      .select()
      .from(schema.affinityReservations)
      .where(eq(schema.affinityReservations.poolId, this.poolConfig.poolId))
      .all()
    for (const reservation of affinityRows) {
      const container = this.allContainers.get(reservation.containerId)
      if (container) {
        try {
          await this.manager.wipeForNewTenant(container.containerId)
          await this.pool.release(container)
        } catch {
          // Best effort during drain
        }
      }
      this.db
        .delete(schema.affinityReservations)
        .where(eq(schema.affinityReservations.tenantId, reservation.tenantId))
        .run()
    }

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
  restoreAffinityTimeout(tenantId: TenantId, container: PoolContainer, remainingMs: number): void {
    if (remainingMs <= 0) {
      // Already expired, flush to pool
      this.flushAffinityToPool(container).catch((err) => {
        console.error(`[Pool] Failed to flush expired affinity for ${tenantId}:`, err)
      })
      return
    }

    this.allContainers.set(container.containerId, container)

    const timeout = setTimeout(async () => {
      this.affinityTimeouts.delete(tenantId)
      this.db
        .delete(schema.affinityReservations)
        .where(eq(schema.affinityReservations.tenantId, tenantId))
        .run()
      const affinityContainer = this.allContainers.get(container.containerId)
      if (affinityContainer) {
        await this.flushAffinityToPool(affinityContainer)
      }
    }, remainingMs)

    this.affinityTimeouts.set(tenantId, timeout)
    console.log(
      `[Pool] Restored affinity for tenant ${tenantId}, container ${container.containerId}, expires in ${remainingMs}ms`,
    )
  }

  /**
   * Restore a claimed container from recovery.
   * Populates allContainers for generic-pool compatibility.
   */
  restoreClaimed(container: PoolContainer): void {
    this.allContainers.set(container.containerId, container)
    console.log(`[Pool] Restored claimed container ${container.containerId}`)
  }

  /**
   * Restore an idle container from recovery.
   * Populates allContainers for generic-pool compatibility.
   */
  async restoreIdle(container: PoolContainer): Promise<void> {
    this.allContainers.set(container.containerId, container)
    console.log(`[Pool] Restored idle container ${container.containerId}`)
  }
}
