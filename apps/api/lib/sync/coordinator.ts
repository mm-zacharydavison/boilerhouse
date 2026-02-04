/**
 * Sync Coordinator
 *
 * Orchestrates sync operations across containers.
 * Handles lifecycle hooks (onClaim, onRelease) and periodic sync scheduling.
 */

import type { PoolContainer, PoolId, SyncMapping, SyncSpec, TenantId } from '@boilerhouse/core'
import type { RcloneSyncExecutor, SyncResult } from './rclone'
import type { SyncRegistry } from './registry'
import type { SyncStatusTracker } from './status'

/**
 * Configuration for the SyncCoordinator.
 */
export interface SyncCoordinatorConfig {
  /**
   * Minimum interval between periodic syncs in milliseconds.
   * Prevents sync specs from configuring excessively frequent syncs.
   * @default 30000
   */
  minSyncIntervalMs?: number

  /**
   * Maximum number of concurrent sync operations.
   * Additional operations are queued until a slot becomes available.
   * @default 5
   */
  maxConcurrent?: number

  /**
   * Enable verbose logging of sync operations.
   * @default false
   */
  verbose?: boolean
}

const DEFAULT_CONFIG: Required<SyncCoordinatorConfig> = {
  minSyncIntervalMs: 30 * 1000,
  maxConcurrent: 5,
  verbose: false,
}

/**
 * Represents an active periodic sync job for a tenant.
 * Tracks the scheduled timer and last sync time for interval-based syncing.
 */
interface PeriodicSyncJob {
  /**
   * ID of the tenant this job belongs to.
   * @example 'tenant-123'
   */
  tenantId: TenantId

  /**
   * The sync specification being executed.
   */
  syncSpec: SyncSpec

  /**
   * The container being synced.
   */
  container: PoolContainer

  /**
   * Interval between syncs in milliseconds.
   * @example 300000
   */
  intervalMs: number

  /**
   * Timestamp of the last sync execution (ms since epoch).
   * @example 1705329000000
   */
  lastSyncAt: number

  /**
   * Timer ID for the scheduled next sync.
   * Used to cancel the job when stopping periodic sync.
   */
  timerId?: ReturnType<typeof setTimeout>
}

export class SyncCoordinator {
  private registry: SyncRegistry
  private executor: RcloneSyncExecutor
  private statusTracker: SyncStatusTracker
  private config: Required<SyncCoordinatorConfig>

  /** Active periodic sync jobs by tenant ID */
  private periodicJobs: Map<string, PeriodicSyncJob[]> = new Map()

  /** Currently running sync operations count */
  private runningCount = 0

  /** Queue of pending sync operations */
  private pendingQueue: Array<() => Promise<void>> = []

  constructor(
    registry: SyncRegistry,
    executor: RcloneSyncExecutor,
    statusTracker: SyncStatusTracker,
    config?: SyncCoordinatorConfig,
  ) {
    this.registry = registry
    this.executor = executor
    this.statusTracker = statusTracker
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Handle container claim - download state from sink.
   *
   * Called when a tenant claims a container from the pool.
   * Executes download mappings for all sync specs with onClaim=true.
   */
  async onClaim(tenantId: TenantId, container: PoolContainer): Promise<SyncResult[]> {
    const results: SyncResult[] = []
    const syncSpecs = this.registry.getByPoolId(container.poolId)

    for (const spec of syncSpecs) {
      if (!spec.policy.onClaim) {
        continue
      }

      // Get download mappings
      const downloadMappings = spec.mappings.filter(
        (m) => m.direction === 'download' || m.direction === 'bidirectional',
      )

      for (const mapping of downloadMappings) {
        const result = await this.executeSync(tenantId, spec, mapping, container)
        results.push(result)
      }

      // Start periodic sync if configured
      if (spec.policy.intervalMs) {
        this.startPeriodicSync(tenantId, spec, container)
      }
    }

    this.log(`[Sync] onClaim completed for tenant ${tenantId}: ${results.length} syncs`)
    return results
  }

  /**
   * Handle container release - upload state to sink.
   *
   * Called when a tenant releases a container back to the pool.
   * Executes upload mappings for all sync specs with onRelease=true.
   */
  async onRelease(tenantId: TenantId, container: PoolContainer): Promise<SyncResult[]> {
    // Stop periodic syncs first
    this.stopPeriodicSync(tenantId)

    const results: SyncResult[] = []
    const syncSpecs = this.registry.getByPoolId(container.poolId)

    for (const spec of syncSpecs) {
      if (!spec.policy.onRelease) {
        continue
      }

      // Get upload mappings
      const uploadMappings = spec.mappings.filter(
        (m) => m.direction === 'upload' || m.direction === 'bidirectional',
      )

      for (const mapping of uploadMappings) {
        const result = await this.executeSync(tenantId, spec, mapping, container)
        results.push(result)
      }
    }

    // Clear status for this tenant
    this.statusTracker.clearTenant(tenantId)

    this.log(`[Sync] onRelease completed for tenant ${tenantId}: ${results.length} syncs`)
    return results
  }

  /**
   * Manually trigger sync for a tenant.
   *
   * @param direction - 'upload', 'download', or 'both'
   */
  async triggerSync(
    tenantId: TenantId,
    container: PoolContainer,
    direction: 'upload' | 'download' | 'both' = 'both',
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = []
    const syncSpecs = this.registry.getByPoolId(container.poolId)

    for (const spec of syncSpecs) {
      if (!spec.policy.allowManualTrigger) {
        continue
      }

      const mappings = spec.mappings.filter((m) => {
        if (direction === 'both') return true
        if (direction === 'upload') {
          return m.direction === 'upload' || m.direction === 'bidirectional'
        }
        return m.direction === 'download' || m.direction === 'bidirectional'
      })

      for (const mapping of mappings) {
        const result = await this.executeSync(tenantId, spec, mapping, container)
        results.push(result)
      }
    }

    this.log(`[Sync] Manual trigger completed for tenant ${tenantId}: ${results.length} syncs`)
    return results
  }

  /**
   * Trigger sync for a specific sync spec.
   */
  async triggerSyncSpec(
    tenantId: TenantId,
    container: PoolContainer,
    syncId: string,
    direction: 'upload' | 'download' | 'both' = 'both',
  ): Promise<SyncResult[]> {
    const spec = this.registry.get(syncId)
    if (!spec) {
      throw new Error(`SyncSpec '${syncId}' not found`)
    }

    if (!spec.policy.allowManualTrigger) {
      throw new Error(`SyncSpec '${syncId}' does not allow manual triggers`)
    }

    const results: SyncResult[] = []
    const mappings = spec.mappings.filter((m) => {
      if (direction === 'both') return true
      if (direction === 'upload') {
        return m.direction === 'upload' || m.direction === 'bidirectional'
      }
      return m.direction === 'download' || m.direction === 'bidirectional'
    })

    for (const mapping of mappings) {
      const result = await this.executeSync(tenantId, spec, mapping, container)
      results.push(result)
    }

    return results
  }

  /**
   * Start periodic sync for a tenant.
   */
  private startPeriodicSync(tenantId: TenantId, spec: SyncSpec, container: PoolContainer): void {
    const specInterval = spec.policy.intervalMs ?? 0
    const intervalMs = Math.max(specInterval, this.config.minSyncIntervalMs)

    const job: PeriodicSyncJob = {
      tenantId,
      syncSpec: spec,
      container,
      intervalMs,
      lastSyncAt: Date.now(),
    }

    // Schedule first periodic sync
    this.schedulePeriodicSync(job)

    // Store job
    const key = this.makeJobKey(tenantId, spec.id)
    let jobList = this.periodicJobs.get(key)
    if (!jobList) {
      jobList = []
      this.periodicJobs.set(key, jobList)
    }
    jobList.push(job)

    this.log(
      `[Sync] Started periodic sync for tenant ${tenantId}, spec ${spec.id} (${intervalMs}ms)`,
    )
  }

  /**
   * Schedule the next periodic sync.
   */
  private schedulePeriodicSync(job: PeriodicSyncJob): void {
    const elapsed = Date.now() - job.lastSyncAt
    const delay = Math.max(0, job.intervalMs - elapsed)

    job.timerId = setTimeout(async () => {
      await this.executePeriodicSync(job)
      job.lastSyncAt = Date.now()
      this.schedulePeriodicSync(job)
    }, delay)
  }

  /**
   * Execute periodic sync for a job.
   */
  private async executePeriodicSync(job: PeriodicSyncJob): Promise<void> {
    const { tenantId, syncSpec, container } = job

    // Only sync upload mappings during periodic sync
    const uploadMappings = syncSpec.mappings.filter(
      (m) => m.direction === 'upload' || m.direction === 'bidirectional',
    )

    for (const mapping of uploadMappings) {
      await this.executeSync(tenantId, syncSpec, mapping, container)
    }
  }

  /**
   * Stop periodic sync for a tenant.
   */
  private stopPeriodicSync(tenantId: TenantId): void {
    const keysToDelete: string[] = []

    for (const [key, jobs] of this.periodicJobs) {
      if (key.startsWith(`${tenantId}:`)) {
        for (const job of jobs) {
          if (job.timerId) {
            clearTimeout(job.timerId)
          }
        }
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.periodicJobs.delete(key)
    }

    if (keysToDelete.length > 0) {
      this.log(`[Sync] Stopped ${keysToDelete.length} periodic sync job(s) for tenant ${tenantId}`)
    }
  }

  /**
   * Execute a single sync operation with concurrency control.
   */
  private async executeSync(
    tenantId: TenantId,
    spec: SyncSpec,
    mapping: SyncMapping,
    container: PoolContainer,
  ): Promise<SyncResult> {
    // Wait for a slot if at max concurrency
    if (this.runningCount >= this.config.maxConcurrent) {
      await this.waitForSlot()
    }

    this.runningCount++
    this.statusTracker.markSyncStarted(tenantId, spec.id)

    try {
      const result = await this.executor.sync(tenantId, mapping, spec.sink, container.stateDir)

      if (result.success) {
        this.statusTracker.markSyncCompleted(tenantId, spec.id)
        this.log(
          `[Sync] Success: tenant=${tenantId}, spec=${spec.id}, path=${mapping.containerPath}, ` +
            `files=${result.filesTransferred ?? 0}, bytes=${result.bytesTransferred ?? 0}`,
        )
      } else {
        const errorMsg = result.errors?.join('; ') ?? 'Unknown error'
        this.statusTracker.markSyncFailed(tenantId, spec.id, errorMsg, mapping.containerPath)
        this.log(
          `[Sync] Failed: tenant=${tenantId}, spec=${spec.id}, path=${mapping.containerPath}, ` +
            `error=${errorMsg}`,
        )
      }

      return result
    } finally {
      this.runningCount--
      this.processQueue()
    }
  }

  /**
   * Wait for a sync slot to become available.
   */
  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      this.pendingQueue.push(async () => resolve())
    })
  }

  /**
   * Process pending sync queue.
   */
  private processQueue(): void {
    if (this.pendingQueue.length > 0 && this.runningCount < this.config.maxConcurrent) {
      const next = this.pendingQueue.shift()
      if (next) {
        next()
      }
    }
  }

  /**
   * Create a unique key for tenant + sync spec.
   */
  private makeJobKey(tenantId: TenantId, syncId: string): string {
    return `${tenantId}:${syncId}`
  }

  /**
   * Log a message if verbose mode is enabled.
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message)
    }
  }

  /**
   * Get all active periodic sync jobs.
   */
  getActiveJobs(): Array<{
    tenantId: TenantId
    syncId: string
    poolId: PoolId
    intervalMs: number
    lastSyncAt: Date
  }> {
    const jobs: Array<{
      tenantId: TenantId
      syncId: string
      poolId: PoolId
      intervalMs: number
      lastSyncAt: Date
    }> = []

    for (const jobList of this.periodicJobs.values()) {
      for (const job of jobList) {
        jobs.push({
          tenantId: job.tenantId,
          syncId: job.syncSpec.id,
          poolId: job.syncSpec.poolId,
          intervalMs: job.intervalMs,
          lastSyncAt: new Date(job.lastSyncAt),
        })
      }
    }

    return jobs
  }

  /**
   * Get current sync stats.
   */
  getStats(): {
    activeJobs: number
    runningOperations: number
    pendingOperations: number
  } {
    let activeJobs = 0
    for (const jobs of this.periodicJobs.values()) {
      activeJobs += jobs.length
    }

    return {
      activeJobs,
      runningOperations: this.runningCount,
      pendingOperations: this.pendingQueue.length,
    }
  }

  /**
   * Stop all sync operations and clear state.
   */
  async shutdown(): Promise<void> {
    // Stop all periodic syncs
    for (const jobs of this.periodicJobs.values()) {
      for (const job of jobs) {
        if (job.timerId) {
          clearTimeout(job.timerId)
        }
      }
    }
    this.periodicJobs.clear()

    // Clear pending queue
    this.pendingQueue = []

    this.log('[Sync] Coordinator shutdown complete')
  }
}
