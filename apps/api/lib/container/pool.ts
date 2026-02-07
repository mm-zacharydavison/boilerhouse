/**
 * Container Pool
 *
 * Manages a pool of pre-warmed containers with DB as the single source of truth.
 * No in-memory idle queue — all state lives in the `containers` table.
 * A background fill loop maintains minimum idle count.
 *
 * Uses wipe-on-entry: released containers go back to idle with `lastTenantId`
 * preserved. On acquire, if the same tenant reclaims → no wipe. If a different
 * tenant claims → wipe first.
 *
 * Concurrency safety: acquire uses optimistic locking via conditional UPDATE
 * with a `WHERE status = 'idle'` guard. If another request claims the container
 * between SELECT and UPDATE, the UPDATE returns nothing and we retry the next
 * candidate. No mutex or explicit transaction needed.
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
import { and, count, eq } from 'drizzle-orm'
import { config } from '../config'
import { PoolCapacityError } from '../errors'
import {
  affinityHitsTotal,
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
  minIdle: number

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

  /** Filesystem inactivity timeout (ms) before auto-releasing a claimed container */
  fileIdleTtl?: number
}

export interface PoolStats {
  size: number
  available: number
  borrowed: number
  pending: number
  minIdle: number
  max: number
}

export interface PoolError {
  message: string
  timestamp: Date
}

export class ContainerPool {
  private manager: ContainerManager
  private poolConfig: ContainerPoolConfig
  private db: DrizzleDb
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
      minIdle: poolConfig.minIdle ?? config.pool.minPoolIdle,
      maxSize: poolConfig.maxSize ?? config.pool.maxContainersPerNode,
      idleTimeoutMs: poolConfig.idleTimeoutMs ?? config.pool.containerIdleTimeoutMs,
      evictionIntervalMs: poolConfig.evictionIntervalMs ?? 30000,
      acquireTimeoutMs: poolConfig.acquireTimeoutMs ?? config.pool.containerStartTimeoutMs,
      networks: poolConfig.networks,
      fileIdleTtl: poolConfig.fileIdleTtl,
    }
  }

  /**
   * Start the background fill loop. Must be called after construction.
   */
  start(): void {
    this.startFillLoop()
  }

  /**
   * Acquire a container for a tenant
   *
   * Priority:
   * 1. If tenant already has a claimed container (from DB), returns it
   * 2. If an idle container has lastTenantId matching this tenant, claim without wipe
   * 3. Otherwise, pick an idle container from DB, wipe, then claim
   * 4. If no idle containers and under maxSize, creates on demand
   *
   * Uses optimistic locking: UPDATE ... WHERE status = 'idle' + .returning()
   * ensures only one concurrent caller wins a given container.
   */
  async acquireForTenant(tenantId: TenantId): Promise<PoolContainer> {
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
        endTimer({ status: 'success' })
        return this.toPoolContainer(existingClaim)
      }

      // 2. Check for idle container with matching lastTenantId (no wipe needed)
      const affinityRow = this.db
        .select()
        .from(schema.containers)
        .where(
          and(
            eq(schema.containers.lastTenantId, tenantId),
            eq(schema.containers.poolId, this.poolConfig.poolId),
            eq(schema.containers.status, 'idle'),
          ),
        )
        .get()

      if (affinityRow) {
        const healthy = await this.manager.isHealthy(affinityRow.containerId)
        if (healthy) {
          // Optimistic lock: only claim if still idle
          const now = new Date()
          const claimed = this.db
            .update(schema.containers)
            .set({
              status: 'claimed' as ContainerStatus,
              tenantId,
              lastActivity: now,
              claimedAt: now,
            })
            .where(
              and(
                eq(schema.containers.containerId, affinityRow.containerId),
                eq(schema.containers.status, 'idle'),
              ),
            )
            .returning()
            .get()

          if (claimed) {
            setContainerInfo(
              affinityRow.containerId,
              this.poolConfig.poolId,
              this.poolConfig.workload.id,
              'claimed',
              tenantId,
            )
            console.log(
              `[Pool] Returned previous container ${affinityRow.containerId} to tenant ${tenantId} (no wipe)`,
            )
            affinityHitsTotal.inc({ pool_id: this.poolConfig.poolId })
            endTimer({ status: 'success' })
            this.emitPoolMetrics()
            return this.toPoolContainer({
              ...affinityRow,
              status: 'claimed',
              tenantId,
              lastActivity: now,
              claimedAt: now,
            })
          }
          // Someone else claimed it — fall through to general idle search
        } else {
          // Container unhealthy, destroy it and fall through
          console.log(`[Pool] Previous container ${affinityRow.containerId} unhealthy, destroying`)
          await this.destroyAndRemove(affinityRow.containerId)
        }
      }

      // 3. Find idle containers from DB — wipe before claiming
      // Loop until we successfully claim one or exhaust all candidates
      for (;;) {
        const candidate = this.db
          .select()
          .from(schema.containers)
          .where(
            and(
              eq(schema.containers.poolId, this.poolConfig.poolId),
              eq(schema.containers.status, 'idle'),
            ),
          )
          .get()

        if (!candidate) break

        // Validate health
        const healthy = await this.manager.isHealthy(candidate.containerId)
        if (!healthy) {
          console.log(
            `[Pool] Idle container ${candidate.containerId} failed health check, destroying`,
          )
          containerHealthCheckFailuresTotal.inc({ pool_id: this.poolConfig.poolId })
          await this.destroyAndRemove(candidate.containerId)
          continue
        }

        // Wipe state for new tenant
        const endWipeTimer = containerWipeDuration.startTimer({ pool_id: this.poolConfig.poolId })
        await this.manager.wipeForNewTenant(candidate.containerId)
        endWipeTimer()
        containerOperationsTotal.inc({
          pool_id: this.poolConfig.poolId,
          operation: 'wipe',
          status: 'success',
        })

        // Optimistic lock: only claim if still idle
        const now = new Date()
        const claimed = this.db
          .update(schema.containers)
          .set({
            status: 'claimed' as ContainerStatus,
            tenantId,
            lastActivity: now,
            claimedAt: now,
          })
          .where(
            and(
              eq(schema.containers.containerId, candidate.containerId),
              eq(schema.containers.status, 'idle'),
            ),
          )
          .returning()
          .get()

        if (!claimed) {
          // Someone else claimed it between our SELECT and UPDATE — retry
          continue
        }

        setContainerInfo(
          candidate.containerId,
          this.poolConfig.poolId,
          this.poolConfig.workload.id,
          'claimed',
          tenantId,
        )

        console.log(
          `[Pool] Claimed container ${candidate.containerId} for tenant ${tenantId} (wiped)`,
        )
        endTimer({ status: 'success' })
        this.emitPoolMetrics()
        return this.toPoolContainer({
          ...candidate,
          status: 'claimed',
          tenantId,
          lastActivity: now,
          claimedAt: now,
        })
      }

      // 4. No idle containers — create on demand if under maxSize
      const totalCount = this.getTotalCount()
      if (totalCount >= this.poolConfig.maxSize) {
        throw new PoolCapacityError(this.poolConfig.poolId, this.poolConfig.maxSize)
      }

      const container = await this.createAndInsert('claimed', tenantId)
      endTimer({ status: 'success' })
      this.emitPoolMetrics()
      return container
    } catch (err) {
      endTimer({ status: 'failure' })
      throw err
    }
  }

  /**
   * Release a tenant's container
   *
   * Sets status to 'idle' with lastTenantId preserved. No wipe on release.
   * Wipe happens on next acquire by a different tenant.
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

      // Set to idle, preserve lastTenantId for affinity matching on next acquire
      this.db
        .update(schema.containers)
        .set({
          status: 'idle' as ContainerStatus,
          tenantId: null,
          lastTenantId: tenantId,
          lastActivity: new Date(),
          claimedAt: null,
        })
        .where(eq(schema.containers.containerId, row.containerId))
        .run()

      setContainerInfo(
        row.containerId,
        this.poolConfig.poolId,
        this.poolConfig.workload.id,
        'idle',
        '',
      )

      console.log(`[Pool] Released container ${row.containerId} from tenant ${tenantId} to idle`)
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
    const stopping = statusCounts.stopping ?? 0

    return {
      size: idle + claimed + stopping,
      available: idle,
      borrowed: claimed,
      pending: 0,
      minIdle: this.poolConfig.minIdle,
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

    while (destroyed < toDestroy) {
      const idleRow = this.db
        .select({ containerId: schema.containers.containerId })
        .from(schema.containers)
        .where(
          and(
            eq(schema.containers.poolId, this.poolConfig.poolId),
            eq(schema.containers.status, 'idle'),
          ),
        )
        .get()

      if (!idleRow) break

      try {
        await this.destroyAndRemove(idleRow.containerId)
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
   * Get the pool configuration
   */
  getConfig(): Readonly<ContainerPoolConfig> {
    return this.poolConfig
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
   * Clears timers but leaves Docker containers running
   * and DB rows intact for recovery on restart.
   */
  stop(): void {
    console.log('[Pool] Stopping pool (preserving containers)...')

    if (this.fillLoopInterval) {
      clearInterval(this.fillLoopInterval)
      this.fillLoopInterval = null
    }

    console.log('[Pool] Pool stopped')
  }

  /**
   * Gracefully drain the pool.
   *
   * Destroys all containers and removes all DB rows for this pool.
   */
  async drain(): Promise<void> {
    console.log('[Pool] Draining pool...')

    if (this.fillLoopInterval) {
      clearInterval(this.fillLoopInterval)
      this.fillLoopInterval = null
    }

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

    console.log('[Pool] Pool drained')
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a container via the manager and insert into DB.
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
   * Fill the pool up to minIdle idle containers.
   */
  private async fillPool(): Promise<void> {
    try {
      const stats = this.getStats()
      const idleNeeded = this.poolConfig.minIdle - stats.available
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
   * Convert a DB row to a PoolContainer using computed paths from the manager.
   */
  private toPoolContainer(row: {
    containerId: ContainerId
    poolId: PoolId
    status: string
    tenantId: TenantId | null
    lastTenantId?: TenantId | null
    lastActivity: Date
    claimedAt?: Date | null
    idleExpiresAt?: Date | null
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
      lastTenantId: row.lastTenantId,
      idleExpiresAt: row.idleExpiresAt,
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
      minIdle: stats.minIdle,
      max: stats.max,
    })
  }
}
