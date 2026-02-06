/**
 * Container Pool
 *
 * Manages a pool of pre-warmed containers with DB as the single source of truth.
 * No external pooling library — uses an in-memory idle queue backed by the
 * `containers` table and a background fill loop to maintain minimum idle count.
 */

import type {
  ContainerId,
  ContainerStatus,
  PoolContainer,
  PoolId,
  TenantId,
  WorkloadSpec,
} from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { and, count, eq, gt } from 'drizzle-orm'
import { config } from '../config'
import {
  affinityEvictionsTotal,
  affinityHitsTotal,
  affinityMissesTotal,
  affinityReservations,
  containerAcquireDuration,
  containerCreateDuration,
  containerDestroyDuration,
  containerHealthCheckFailuresTotal,
  containerOperationsTotal,
  containerReleaseDuration,
  containerWipeDuration,
  removeContainerInfo,
  setContainerInfo,
  updatePoolMetrics,
} from '../metrics'
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

  /** Optional Docker networks override */
  networks?: string[]

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
  private poolConfig: ContainerPoolConfig
  private db: DrizzleDb
  /** In-memory queue of idle container IDs for fast acquire */
  private idleQueue: ContainerId[] = []
  /** Timeouts to return affinity containers to pool */
  private affinityTimeouts: Map<TenantId, ReturnType<typeof setTimeout>> = new Map()
  /** Background fill loop timer */
  private fillLoopInterval: ReturnType<typeof setInterval> | null = null
  private _lastError: PoolError | null = null

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
      networks: poolConfig.networks,
      affinityTimeoutMs: poolConfig.affinityTimeoutMs ?? 0,
    }

    this.loadFromDb()
    this.startFillLoop()
  }

  /**
   * Load idle containers and affinity reservations from DB into in-memory structures.
   */
  private loadFromDb(): void {
    // Restore idle queue
    const idleRows = this.db
      .select({ containerId: schema.containers.containerId })
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'idle'),
        ),
      )
      .all()

    this.idleQueue = idleRows.map((r) => r.containerId)

    // Restore affinity timeouts
    const now = new Date()
    const reservedRows = this.db
      .select()
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'reserved'),
          gt(schema.containers.affinityExpiresAt, now),
        ),
      )
      .all()

    for (const row of reservedRows) {
      if (!row.tenantId || !row.affinityExpiresAt) continue
      const remainingMs = row.affinityExpiresAt.getTime() - Date.now()
      if (remainingMs > 0) {
        this.startAffinityTimeout(row.tenantId, row.containerId, remainingMs)
      } else {
        // Already expired, flush to idle
        this.flushAffinityToIdle(row.containerId).catch((err) => {
          console.error(`[Pool] Failed to flush expired affinity for ${row.tenantId}:`, err)
        })
      }
    }

    console.log(
      `[Pool ${this.poolConfig.poolId}] Loaded ${this.idleQueue.length} idle, ${reservedRows.length} reserved from DB`,
    )
  }

  /**
   * Acquire a container for a tenant
   *
   * Priority:
   * 1. If tenant already has a claimed container (from DB), returns it
   * 2. If tenant has an affinity container (their previous container), returns it
   * 3. Otherwise, pops from idle queue
   * 4. If queue empty and under maxSize, creates on demand
   */
  async acquireForTenant(tenantId: TenantId): Promise<AcquireResult> {
    const endTimer = containerAcquireDuration.startTimer({ pool_id: this.poolConfig.poolId })

    try {
      // 1. Check if tenant already has a claimed container
      const existingClaim = this.db
        .select()
        .from(schema.containers)
        .where(
          and(
            eq(schema.containers.tenantId, tenantId),
            eq(schema.containers.poolId, this.poolConfig.poolId),
            eq(schema.containers.status, 'claimed'),
          ),
        )
        .get()

      if (existingClaim) {
        this.db
          .update(schema.containers)
          .set({ lastActivity: new Date() })
          .where(eq(schema.containers.containerId, existingClaim.containerId))
          .run()
        affinityHitsTotal.inc({ pool_id: this.poolConfig.poolId })
        endTimer({ status: 'success' })
        return { container: this.toPoolContainer(existingClaim), isAffinityMatch: true }
      }

      // 2. Check for affinity reservation
      const affinityRow = this.db
        .select()
        .from(schema.containers)
        .where(
          and(
            eq(schema.containers.tenantId, tenantId),
            eq(schema.containers.poolId, this.poolConfig.poolId),
            eq(schema.containers.status, 'reserved'),
          ),
        )
        .get()

      if (affinityRow) {
        // Clear the timeout
        const timeout = this.affinityTimeouts.get(tenantId)
        if (timeout) {
          clearTimeout(timeout)
          this.affinityTimeouts.delete(tenantId)
        }

        // Validate health
        const healthy = await this.manager.isHealthy(affinityRow.containerId)
        if (healthy) {
          const now = new Date()
          this.db
            .update(schema.containers)
            .set({
              status: 'claimed' as ContainerStatus,
              lastActivity: now,
              claimedAt: now,
              affinityExpiresAt: null,
            })
            .where(eq(schema.containers.containerId, affinityRow.containerId))
            .run()

          setContainerInfo(
            affinityRow.containerId,
            this.poolConfig.poolId,
            this.poolConfig.workload.id,
            'claimed',
            tenantId,
          )
          console.log(
            `[Pool] Returned affinity container ${affinityRow.containerId} to tenant ${tenantId}`,
          )
          affinityHitsTotal.inc({ pool_id: this.poolConfig.poolId })
          endTimer({ status: 'success' })
          this.emitPoolMetrics()
          return {
            container: this.toPoolContainer({
              ...affinityRow,
              status: 'claimed',
              lastActivity: now,
              claimedAt: now,
            }),
            isAffinityMatch: true,
          }
        }

        // Container unhealthy, destroy it and fall through
        console.log(`[Pool] Affinity container ${affinityRow.containerId} unhealthy, destroying`)
        await this.destroyAndRemove(affinityRow.containerId)
      }

      // 3. Pop from idle queue
      affinityMissesTotal.inc({ pool_id: this.poolConfig.poolId })

      while (this.idleQueue.length > 0) {
        const candidateId = this.idleQueue.shift()
        if (!candidateId) break
        // Validate it's still idle in DB
        const row = this.db
          .select()
          .from(schema.containers)
          .where(
            and(
              eq(schema.containers.containerId, candidateId),
              eq(schema.containers.status, 'idle'),
            ),
          )
          .get()
        if (!row) continue

        // Validate health
        const healthy = await this.manager.isHealthy(candidateId)
        if (!healthy) {
          console.log(`[Pool] Idle container ${candidateId} failed health check, destroying`)
          containerHealthCheckFailuresTotal.inc({ pool_id: this.poolConfig.poolId })
          await this.destroyAndRemove(candidateId)
          continue
        }

        // Claim it
        const now = new Date()
        this.db
          .update(schema.containers)
          .set({
            status: 'claimed' as ContainerStatus,
            tenantId,
            lastActivity: now,
            claimedAt: now,
          })
          .where(eq(schema.containers.containerId, candidateId))
          .run()

        setContainerInfo(
          candidateId,
          this.poolConfig.poolId,
          this.poolConfig.workload.id,
          'claimed',
          tenantId,
        )

        console.log(`[Pool] Claimed container ${candidateId} for tenant ${tenantId}`)
        endTimer({ status: 'success' })
        this.emitPoolMetrics()
        return {
          container: this.toPoolContainer({
            ...row,
            status: 'claimed',
            tenantId,
            lastActivity: now,
            claimedAt: now,
          }),
          isAffinityMatch: false,
        }
      }

      // 4. Queue empty — create on demand if under maxSize
      const totalCount = this.getTotalCount()
      if (totalCount >= this.poolConfig.maxSize) {
        throw new Error(
          `Pool ${this.poolConfig.poolId} is at maximum capacity (${this.poolConfig.maxSize})`,
        )
      }

      const container = await this.createAndInsert('claimed', tenantId)
      endTimer({ status: 'success' })
      this.emitPoolMetrics()
      return { container, isAffinityMatch: false }
    } catch (err) {
      endTimer({ status: 'failure' })
      throw err
    }
  }

  /**
   * Release a tenant's container
   *
   * Sets status to 'reserved' with an affinity timeout. After timeout,
   * the container is wiped and returned to idle for other tenants.
   */
  async releaseForTenant(tenantId: TenantId): Promise<void> {
    const endTimer = containerReleaseDuration.startTimer({ pool_id: this.poolConfig.poolId })

    try {
      // Find container via DB
      const row = this.db
        .select()
        .from(schema.containers)
        .where(
          and(
            eq(schema.containers.tenantId, tenantId),
            eq(schema.containers.poolId, this.poolConfig.poolId),
            eq(schema.containers.status, 'claimed'),
          ),
        )
        .get()

      if (!row) {
        console.log(`[Pool] No container found for tenant ${tenantId}`)
        endTimer({ status: 'success' })
        return
      }

      // Clear any existing affinity for this tenant
      const existingTimeout = this.affinityTimeouts.get(tenantId)
      if (existingTimeout) {
        clearTimeout(existingTimeout)
        this.affinityTimeouts.delete(tenantId)
      }

      // Check for existing affinity container (from a previous release) and flush it
      const existingAffinity = this.db
        .select()
        .from(schema.containers)
        .where(
          and(
            eq(schema.containers.tenantId, tenantId),
            eq(schema.containers.poolId, this.poolConfig.poolId),
            eq(schema.containers.status, 'reserved'),
          ),
        )
        .get()
      if (existingAffinity) {
        await this.flushAffinityToIdle(existingAffinity.containerId)
      }

      // Update container to reserved with affinity timeout
      const expiresAt = new Date(Date.now() + this.poolConfig.affinityTimeoutMs)
      this.db
        .update(schema.containers)
        .set({
          status: 'reserved' as ContainerStatus,
          lastActivity: new Date(),
          claimedAt: null,
          affinityExpiresAt: expiresAt,
        })
        .where(eq(schema.containers.containerId, row.containerId))
        .run()

      setContainerInfo(
        row.containerId,
        this.poolConfig.poolId,
        this.poolConfig.workload.id,
        'reserved',
        tenantId,
      )

      // Start affinity timeout
      this.startAffinityTimeout(tenantId, row.containerId, this.poolConfig.affinityTimeoutMs)

      console.log(
        `[Pool] Released container ${row.containerId} from tenant ${tenantId} (reserved for ${this.poolConfig.affinityTimeoutMs}ms)`,
      )
      endTimer({ status: 'success' })
      this.emitPoolMetrics()
    } catch (err) {
      endTimer({ status: 'failure' })
      throw err
    }
  }

  /**
   * Destroy a tenant's container completely
   */
  async destroyForTenant(tenantId: TenantId): Promise<void> {
    const row = this.db
      .select()
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.tenantId, tenantId),
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'claimed'),
        ),
      )
      .get()

    if (!row) return
    await this.destroyAndRemove(row.containerId)
    console.log(`[Pool] Destroyed container ${row.containerId} for tenant ${tenantId}`)
  }

  /**
   * Destroy a container by ID
   */
  async destroyContainer(containerId: string): Promise<boolean> {
    const row = this.db
      .select()
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.containerId, containerId as ContainerId),
          eq(schema.containers.poolId, this.poolConfig.poolId),
        ),
      )
      .get()

    if (!row) return false

    // If claimed, clear tenant's affinity timeout
    if (row.tenantId) {
      const timeout = this.affinityTimeouts.get(row.tenantId)
      if (timeout) {
        clearTimeout(timeout)
        this.affinityTimeouts.delete(row.tenantId)
      }
    }

    // Remove from idle queue if present
    this.removeFromIdleQueue(containerId as ContainerId)

    await this.destroyAndRemove(containerId as ContainerId)
    console.log(`[Pool] Destroyed container ${containerId}`)
    return true
  }

  /**
   * Get container for a tenant (if claimed in this pool)
   */
  getContainerForTenant(tenantId: TenantId): PoolContainer | undefined {
    const row = this.db
      .select()
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.tenantId, tenantId),
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'claimed'),
        ),
      )
      .get()

    if (!row) return undefined
    return this.toPoolContainer(row)
  }

  /**
   * Check if tenant has a claimed container in this pool
   */
  hasTenant(tenantId: TenantId): boolean {
    const row = this.db
      .select({ containerId: schema.containers.containerId })
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.tenantId, tenantId),
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'claimed'),
        ),
      )
      .get()

    return row !== undefined
  }

  /**
   * Record activity for a tenant's container
   */
  recordActivity(tenantId: TenantId): void {
    this.db
      .update(schema.containers)
      .set({ lastActivity: new Date() })
      .where(
        and(
          eq(schema.containers.tenantId, tenantId),
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'claimed'),
        ),
      )
      .run()
  }

  /**
   * Get pool statistics from DB
   */
  getStats(): PoolStats {
    const rows = this.db
      .select({
        status: schema.containers.status,
        cnt: count(),
      })
      .from(schema.containers)
      .where(eq(schema.containers.poolId, this.poolConfig.poolId))
      .groupBy(schema.containers.status)
      .all()

    const statusCounts: Record<string, number> = {}
    for (const row of rows) {
      statusCounts[row.status] = row.cnt
    }

    const idle = statusCounts.idle ?? 0
    const claimed = statusCounts.claimed ?? 0
    const reserved = statusCounts.reserved ?? 0
    const stopping = statusCounts.stopping ?? 0

    return {
      size: idle + claimed + reserved + stopping,
      available: idle,
      borrowed: claimed,
      pending: 0,
      min: this.poolConfig.minSize,
      max: this.poolConfig.maxSize,
    }
  }

  /**
   * Scale the pool to a target size.
   */
  async scaleTo(targetSize: number): Promise<{ newSize: number; message: string }> {
    if (targetSize < 0) {
      throw new Error('Target size cannot be negative')
    }

    if (targetSize > this.poolConfig.maxSize) {
      throw new Error(`Cannot scale above max size ${this.poolConfig.maxSize}`)
    }

    const stats = this.getStats()
    const currentSize = stats.size

    if (targetSize === currentSize) {
      return { newSize: currentSize, message: 'Already at target size' }
    }

    if (targetSize > currentSize) {
      // Scale up: create new idle containers
      const toCreate = targetSize - currentSize
      console.log(`[Pool] Scaling up: creating ${toCreate} containers`)

      for (let i = 0; i < toCreate; i++) {
        try {
          await this.createAndInsert('idle')
        } catch (err) {
          console.error('[Pool] Failed to create container during scale up:', err)
          break
        }
      }

      const newSize = this.getStats().size
      console.log(`[Pool] Scale up complete: ${currentSize} -> ${newSize}`)
      return { newSize, message: `Scaled up from ${currentSize} to ${newSize}` }
    }

    // Scale down: destroy idle containers
    if (targetSize < stats.borrowed) {
      console.log(
        `[Pool] Cannot scale to ${targetSize}, ${stats.borrowed} containers are claimed. Min possible: ${stats.borrowed}`,
      )
      return {
        newSize: currentSize,
        message: `Cannot scale below ${stats.borrowed} claimed containers`,
      }
    }

    const toDestroy = currentSize - targetSize
    let destroyed = 0

    console.log(`[Pool] Scaling down: destroying ${toDestroy} idle containers`)

    while (destroyed < toDestroy && this.idleQueue.length > 0) {
      const containerId = this.idleQueue.shift()
      if (!containerId) break
      try {
        await this.destroyAndRemove(containerId)
        destroyed++
      } catch (err) {
        console.error('[Pool] Failed to destroy container during scale down:', err)
        break
      }
    }

    const newSize = this.getStats().size
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
   * Get all containers in this pool from DB.
   */
  getAllContainers(): PoolContainer[] {
    const rows = this.db
      .select()
      .from(schema.containers)
      .where(eq(schema.containers.poolId, this.poolConfig.poolId))
      .all()

    return rows.map((row) => this.toPoolContainer(row))
  }

  /**
   * Get all claimed tenant IDs in this pool
   */
  getTenantsWithClaims(): TenantId[] {
    return this.db
      .select({ tenantId: schema.containers.tenantId })
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'claimed'),
        ),
      )
      .all()
      .filter((r): r is { tenantId: TenantId } => r.tenantId !== null)
      .map((r) => r.tenantId)
  }

  /**
   * Stop the pool without destroying containers.
   *
   * Clears timers and in-memory state but leaves Docker containers running
   * and DB rows intact for recovery on restart.
   */
  stop(): void {
    console.log('[Pool] Stopping pool (preserving containers)...')

    // Stop fill loop
    if (this.fillLoopInterval) {
      clearInterval(this.fillLoopInterval)
      this.fillLoopInterval = null
    }

    // Clear all affinity timeouts
    for (const timeout of this.affinityTimeouts.values()) {
      clearTimeout(timeout)
    }
    this.affinityTimeouts.clear()

    console.log('[Pool] Pool stopped')
  }

  /**
   * Gracefully drain the pool.
   *
   * Destroys all containers and removes all DB rows for this pool.
   */
  async drain(): Promise<void> {
    console.log('[Pool] Draining pool...')

    // Stop fill loop
    if (this.fillLoopInterval) {
      clearInterval(this.fillLoopInterval)
      this.fillLoopInterval = null
    }

    // Clear all affinity timeouts
    for (const timeout of this.affinityTimeouts.values()) {
      clearTimeout(timeout)
    }
    this.affinityTimeouts.clear()

    // Get all containers for this pool
    const rows = this.db
      .select()
      .from(schema.containers)
      .where(eq(schema.containers.poolId, this.poolConfig.poolId))
      .all()

    // Destroy all containers
    for (const row of rows) {
      try {
        await this.manager.destroyContainer(row.containerId)
        removeContainerInfo(row.containerId)
        containerOperationsTotal.inc({
          pool_id: this.poolConfig.poolId,
          operation: 'destroy',
          status: 'success',
        })
      } catch (err) {
        containerOperationsTotal.inc({
          pool_id: this.poolConfig.poolId,
          operation: 'destroy',
          status: 'failure',
        })
        console.error(`[Pool] Failed to destroy container ${row.containerId} during drain:`, err)
      }
    }

    // Delete all DB rows for this pool
    this.db
      .delete(schema.containers)
      .where(eq(schema.containers.poolId, this.poolConfig.poolId))
      .run()

    this.idleQueue = []

    console.log('[Pool] Pool drained')
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a container via the manager, insert into DB, and optionally add to idle queue.
   */
  private async createAndInsert(
    status: 'idle' | 'claimed',
    tenantId?: TenantId,
  ): Promise<PoolContainer> {
    console.log('[Pool] Creating new container')
    const endTimer = containerCreateDuration.startTimer({
      pool_id: this.poolConfig.poolId,
      workload_id: this.poolConfig.workload.id,
    })

    try {
      const container = await this.manager.createContainer(
        this.poolConfig.workload,
        this.poolConfig.poolId,
        this.poolConfig.networks,
      )
      console.log(`[Pool] Created container ${container.containerId}`)
      this._lastError = null

      const now = new Date()
      this.db
        .insert(schema.containers)
        .values({
          containerId: container.containerId,
          poolId: this.poolConfig.poolId,
          status,
          tenantId: tenantId ?? null,
          lastActivity: now,
          claimedAt: status === 'claimed' ? now : null,
          createdAt: now,
        })
        .run()

      if (status === 'idle') {
        this.idleQueue.push(container.containerId)
      }

      const effectiveTenantId = tenantId ?? ''
      setContainerInfo(
        container.containerId,
        this.poolConfig.poolId,
        this.poolConfig.workload.id,
        status,
        effectiveTenantId,
      )
      endTimer()
      containerOperationsTotal.inc({
        pool_id: this.poolConfig.poolId,
        operation: 'create',
        status: 'success',
      })
      this.emitPoolMetrics()

      return {
        ...container,
        status,
        tenantId: tenantId ?? null,
        lastActivity: now,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Pool] Failed to create container: ${message}`)
      this._lastError = { message, timestamp: new Date() }
      endTimer()
      containerOperationsTotal.inc({
        pool_id: this.poolConfig.poolId,
        operation: 'create',
        status: 'failure',
      })
      throw err
    }
  }

  /**
   * Destroy a container via manager and remove its DB row.
   */
  private async destroyAndRemove(containerId: ContainerId): Promise<void> {
    const endTimer = containerDestroyDuration.startTimer({
      pool_id: this.poolConfig.poolId,
    })

    try {
      await this.manager.destroyContainer(containerId)
      this.db.delete(schema.containers).where(eq(schema.containers.containerId, containerId)).run()
      this.removeFromIdleQueue(containerId)
      removeContainerInfo(containerId)
      endTimer()
      containerOperationsTotal.inc({
        pool_id: this.poolConfig.poolId,
        operation: 'destroy',
        status: 'success',
      })
      this.emitPoolMetrics()
    } catch (err) {
      // Still remove the DB row even if runtime destroy fails
      this.db.delete(schema.containers).where(eq(schema.containers.containerId, containerId)).run()
      this.removeFromIdleQueue(containerId)
      removeContainerInfo(containerId)
      endTimer()
      containerOperationsTotal.inc({
        pool_id: this.poolConfig.poolId,
        operation: 'destroy',
        status: 'failure',
      })
      throw err
    }
  }

  /**
   * Wipe an affinity container and return it to idle in DB and queue.
   */
  private async flushAffinityToIdle(containerId: ContainerId): Promise<void> {
    try {
      const endWipeTimer = containerWipeDuration.startTimer({ pool_id: this.poolConfig.poolId })
      await this.manager.wipeForNewTenant(containerId)
      endWipeTimer()
      containerOperationsTotal.inc({
        pool_id: this.poolConfig.poolId,
        operation: 'wipe',
        status: 'success',
      })

      this.db
        .update(schema.containers)
        .set({
          status: 'idle' as ContainerStatus,
          tenantId: null,
          lastActivity: new Date(),
          claimedAt: null,
          affinityExpiresAt: null,
        })
        .where(eq(schema.containers.containerId, containerId))
        .run()

      this.idleQueue.push(containerId)
      setContainerInfo(containerId, this.poolConfig.poolId, this.poolConfig.workload.id, 'idle', '')
      console.log(`[Pool] Flushed affinity container ${containerId} back to idle`)
      this.emitPoolMetrics()
    } catch (err) {
      containerOperationsTotal.inc({
        pool_id: this.poolConfig.poolId,
        operation: 'wipe',
        status: 'failure',
      })
      console.error(`[Pool] Failed to flush affinity container ${containerId}:`, err)
      // Try to destroy it since we couldn't return it cleanly
      try {
        await this.destroyAndRemove(containerId)
      } catch {
        // Best effort
      }
    }
  }

  /**
   * Start an affinity timeout for a tenant's container.
   */
  private startAffinityTimeout(
    tenantId: TenantId,
    containerId: ContainerId,
    timeoutMs: number,
  ): void {
    const timeout = setTimeout(async () => {
      this.affinityTimeouts.delete(tenantId)
      affinityEvictionsTotal.inc({ pool_id: this.poolConfig.poolId })

      // Verify container is still reserved
      const row = this.db
        .select()
        .from(schema.containers)
        .where(
          and(
            eq(schema.containers.containerId, containerId),
            eq(schema.containers.status, 'reserved'),
          ),
        )
        .get()

      if (row) {
        await this.flushAffinityToIdle(containerId)
      }
    }, timeoutMs)

    this.affinityTimeouts.set(tenantId, timeout)
    this.updateAffinityMetrics()
  }

  /**
   * Background fill loop — maintains minimum idle count.
   */
  private startFillLoop(): void {
    if (this.poolConfig.evictionIntervalMs <= 0) return

    // Fill immediately on startup, then periodically
    this.fillPool()

    this.fillLoopInterval = setInterval(() => {
      this.fillPool()
    }, this.poolConfig.evictionIntervalMs)
  }

  /**
   * Fill the pool up to minSize idle containers.
   */
  private async fillPool(): Promise<void> {
    try {
      const stats = this.getStats()
      const idleNeeded = this.poolConfig.minSize - stats.available
      const capacityLeft = this.poolConfig.maxSize - stats.size

      if (idleNeeded > 0 && capacityLeft > 0) {
        const toCreate = Math.min(idleNeeded, capacityLeft)
        console.log(`[Pool ${this.poolConfig.poolId}] Fill loop: creating ${toCreate} containers`)
        for (let i = 0; i < toCreate; i++) {
          try {
            await this.createAndInsert('idle')
          } catch (err) {
            console.error('[Pool] Fill loop create error:', err)
            break
          }
        }
      }
    } catch (err) {
      console.error('[Pool] Fill loop error:', err)
    }
  }

  /**
   * Get total container count for this pool.
   */
  private getTotalCount(): number {
    const result = this.db
      .select({ cnt: count() })
      .from(schema.containers)
      .where(eq(schema.containers.poolId, this.poolConfig.poolId))
      .get()
    return result?.cnt ?? 0
  }

  /**
   * Remove a container ID from the idle queue.
   */
  private removeFromIdleQueue(containerId: ContainerId): void {
    const idx = this.idleQueue.indexOf(containerId)
    if (idx !== -1) {
      this.idleQueue.splice(idx, 1)
    }
  }

  /**
   * Convert a DB row to a PoolContainer using computed paths from the manager.
   */
  private toPoolContainer(row: {
    containerId: ContainerId
    poolId: PoolId
    status: string
    tenantId: TenantId | null
    lastActivity: Date
    claimedAt?: Date | null
  }): PoolContainer {
    return {
      containerId: row.containerId,
      tenantId: row.tenantId,
      poolId: row.poolId,
      socketPath: this.manager.getSocketPath(row.containerId),
      stateDir: this.manager.getStateDir(row.containerId),
      secretsDir: this.manager.getSecretsDir(row.containerId),
      lastActivity: row.lastActivity,
      status: row.status as ContainerStatus,
    }
  }

  /**
   * Emit current pool metrics to Prometheus.
   */
  private emitPoolMetrics(): void {
    const stats = this.getStats()
    updatePoolMetrics({
      poolId: this.poolConfig.poolId,
      workloadId: this.poolConfig.workload.id,
      size: stats.size,
      available: stats.available,
      borrowed: stats.borrowed,
      pending: stats.pending,
      min: stats.min,
      max: stats.max,
    })
  }

  /**
   * Update affinity reservation gauge.
   */
  private updateAffinityMetrics(): void {
    const result = this.db
      .select({ cnt: count() })
      .from(schema.containers)
      .where(
        and(
          eq(schema.containers.poolId, this.poolConfig.poolId),
          eq(schema.containers.status, 'reserved'),
        ),
      )
      .get()
    affinityReservations.set({ pool_id: this.poolConfig.poolId }, result?.cnt ?? 0)
  }
}
