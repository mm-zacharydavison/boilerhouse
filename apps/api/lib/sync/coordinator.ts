/**
 * Sync Coordinator
 *
 * Orchestrates sync operations across containers.
 * Handles lifecycle hooks (onClaim, onRelease) and periodic sync scheduling.
 *
 * Sync config is read from WorkloadSpec.sync - there is no separate sync registry.
 */

import type {
  PoolContainer,
  TenantId,
  WorkloadId,
  WorkloadSyncConfig,
  WorkloadSyncMapping,
  WorkloadSyncPolicy,
} from '@boilerhouse/core'
import type { Logger } from '../logger'
import {
  classifySyncError,
  syncBisyncResyncTotal,
  syncBytesTransferredTotal,
  syncConcurrentOperations,
  syncDuration,
  syncErrorsTotal,
  syncFilesTransferredTotal,
  syncOperationsTotal,
  syncPeriodicJobsActive,
  syncQueueLength,
} from '../metrics'
import type { RcloneSyncExecutor, SyncResult } from './rclone'
import type { SyncStatusTracker } from './status'

/**
 * Configuration for the SyncCoordinator.
 */
export interface SyncCoordinatorConfig {
  /**
   * Minimum interval between periodic syncs in milliseconds.
   * Prevents excessively frequent syncs.
   * @default 30000
   */
  minSyncInterval?: number

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
  minSyncInterval: 30 * 1000,
  maxConcurrent: 5,
  verbose: false,
}

const DEFAULT_POLICY: WorkloadSyncPolicy = {
  onClaim: true,
  onRelease: true,
  manual: true,
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
   * The sync configuration from the workload spec.
   */
  syncConfig: WorkloadSyncConfig

  /**
   * The container being synced.
   */
  container: PoolContainer

  /**
   * Interval between syncs in milliseconds.
   * @example 300000
   */
  interval: number

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
  private executor: RcloneSyncExecutor
  private statusTracker: SyncStatusTracker
  private config: Required<SyncCoordinatorConfig>
  private _log: Logger

  /** Active periodic sync jobs by tenant ID */
  private periodicJobs: Map<TenantId, PeriodicSyncJob> = new Map()

  /** Currently running sync operations count */
  private runningCount = 0

  /** Queue of pending sync operations */
  private pendingQueue: Array<() => Promise<void>> = []

  constructor(
    executor: RcloneSyncExecutor,
    statusTracker: SyncStatusTracker,
    logger: Logger,
    config?: SyncCoordinatorConfig,
  ) {
    this.executor = executor
    this.statusTracker = statusTracker
    this.config = { ...DEFAULT_CONFIG, ...config }
    this._log = logger.child({ component: 'SyncCoordinator' })
  }

  /**
   * Handle container claim - download state from sink.
   *
   * Called when a tenant claims a container from the pool.
   * Executes download mappings if onClaim is enabled.
   *
   * @param tenantId - The tenant claiming the container
   * @param container - The container being claimed
   * @param syncConfig - Sync configuration from the workload spec (optional)
   * @param initialSync - If true, this is a new container (uses --resync for bisync).
   *                      If false, tenant is returning to same container (incremental bisync).
   */
  async onClaim(
    tenantId: TenantId,
    container: PoolContainer,
    syncConfig?: WorkloadSyncConfig,
    initialSync = true,
  ): Promise<SyncResult[]> {
    if (!syncConfig) {
      return []
    }

    const results: SyncResult[] = []
    const policy: WorkloadSyncPolicy = { ...DEFAULT_POLICY, ...syncConfig.policy }

    if (!policy.onClaim) {
      return results
    }

    // Get download mappings
    const mappings = syncConfig.mappings ?? []
    const downloadMappings = mappings.filter(
      (m) => m.direction === 'download' || m.direction === 'bidirectional',
    )

    for (const mapping of downloadMappings) {
      const result = await this.executeSync(tenantId, syncConfig, mapping, container, initialSync)
      results.push(result)
    }

    // Start periodic sync if configured
    if (policy.interval) {
      this.startPeriodicSync(tenantId, syncConfig, container)
    }

    this.log(
      `onClaim completed for tenant ${tenantId}: ${results.length} syncs (initialSync=${initialSync})`,
    )
    return results
  }

  /**
   * Handle container release - upload state to sink.
   *
   * Called when a tenant releases a container back to the pool.
   * Executes upload mappings if onRelease is enabled.
   *
   * @param tenantId - The tenant releasing the container
   * @param container - The container being released
   * @param syncConfig - Sync configuration from the workload spec (optional)
   */
  async onRelease(
    tenantId: TenantId,
    container: PoolContainer,
    syncConfig?: WorkloadSyncConfig,
  ): Promise<SyncResult[]> {
    // Stop periodic syncs first
    this.stopPeriodicSync(tenantId)

    if (!syncConfig) {
      this.statusTracker.clearTenant(tenantId)
      return []
    }

    const results: SyncResult[] = []
    const policy: WorkloadSyncPolicy = { ...DEFAULT_POLICY, ...syncConfig.policy }

    if (!policy.onRelease) {
      this.statusTracker.clearTenant(tenantId)
      return results
    }

    // Get upload mappings
    const mappings = syncConfig.mappings ?? []
    const uploadMappings = mappings.filter(
      (m) => m.direction === 'upload' || m.direction === 'bidirectional',
    )

    for (const mapping of uploadMappings) {
      const result = await this.executeSync(tenantId, syncConfig, mapping, container)
      results.push(result)
    }

    // Clear status for this tenant
    this.statusTracker.clearTenant(tenantId)

    this.log(`onRelease completed for tenant ${tenantId}: ${results.length} syncs`)
    return results
  }

  /**
   * Manually trigger sync for a tenant.
   *
   * @param tenantId - The tenant to sync
   * @param container - The tenant's container
   * @param syncConfig - Sync configuration from the workload spec
   * @param direction - 'upload', 'download', or 'both'
   */
  async triggerSync(
    tenantId: TenantId,
    container: PoolContainer,
    syncConfig?: WorkloadSyncConfig,
    direction: 'upload' | 'download' | 'both' = 'both',
  ): Promise<SyncResult[]> {
    if (!syncConfig) {
      return []
    }

    const policy: WorkloadSyncPolicy = { ...DEFAULT_POLICY, ...syncConfig.policy }
    if (!policy.manual) {
      return []
    }

    const results: SyncResult[] = []
    const mappings = syncConfig.mappings ?? []

    const filteredMappings = mappings.filter((m) => {
      if (direction === 'both') return true
      if (direction === 'upload') {
        return m.direction === 'upload' || m.direction === 'bidirectional'
      }
      return m.direction === 'download' || m.direction === 'bidirectional'
    })

    for (const mapping of filteredMappings) {
      const result = await this.executeSync(tenantId, syncConfig, mapping, container)
      results.push(result)
    }

    this.log(`Manual trigger completed for tenant ${tenantId}: ${results.length} syncs`)
    return results
  }

  /**
   * Start periodic sync for a tenant.
   */
  private startPeriodicSync(
    tenantId: TenantId,
    syncConfig: WorkloadSyncConfig,
    container: PoolContainer,
  ): void {
    const policy: WorkloadSyncPolicy = { ...DEFAULT_POLICY, ...syncConfig.policy }
    const specInterval = policy.interval ?? 0
    const interval = Math.max(specInterval, this.config.minSyncInterval)
    const workloadId = container.poolId as WorkloadId

    const job: PeriodicSyncJob = {
      tenantId,
      syncConfig,
      container,
      interval,
      lastSyncAt: Date.now(),
    }

    // Schedule first periodic sync
    this.schedulePeriodicSync(job)

    // Store job (one per tenant)
    this.periodicJobs.set(tenantId, job)
    this.updatePeriodicJobMetrics(workloadId)

    this.log(`Started periodic sync for tenant ${tenantId} (${interval}ms)`)
  }

  /**
   * Schedule the next periodic sync.
   */
  private schedulePeriodicSync(job: PeriodicSyncJob): void {
    const elapsed = Date.now() - job.lastSyncAt
    const delay = Math.max(0, job.interval - elapsed)

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
    const { tenantId, syncConfig, container } = job

    // Only sync upload mappings during periodic sync
    const mappings = syncConfig.mappings ?? []
    const uploadMappings = mappings.filter(
      (m) => m.direction === 'upload' || m.direction === 'bidirectional',
    )

    for (const mapping of uploadMappings) {
      await this.executeSync(tenantId, syncConfig, mapping, container)
    }
  }

  /**
   * Stop periodic sync for a tenant.
   */
  private stopPeriodicSync(tenantId: TenantId): void {
    const job = this.periodicJobs.get(tenantId)
    if (job) {
      const workloadId = job.container.poolId as WorkloadId
      if (job.timerId) {
        clearTimeout(job.timerId)
      }
      this.periodicJobs.delete(tenantId)
      this.updatePeriodicJobMetrics(workloadId)
      this.log(`Stopped periodic sync for tenant ${tenantId}`)
    }
  }

  /**
   * Execute a single sync operation with concurrency control.
   *
   * @param initialSync - If true, this is the first sync for a new container (uses --resync for bisync)
   */
  private async executeSync(
    tenantId: TenantId,
    syncConfig: WorkloadSyncConfig,
    mapping: WorkloadSyncMapping,
    container: PoolContainer,
    initialSync = false,
  ): Promise<SyncResult> {
    const workloadId = container.poolId as WorkloadId // poolId corresponds to workloadId
    const direction = mapping.direction ?? 'bidirectional'
    const mode = mapping.mode ?? 'sync'

    // Wait for a slot if at max concurrency
    if (this.runningCount >= this.config.maxConcurrent) {
      await this.waitForSlot()
    }

    this.runningCount++
    this.updateConcurrencyMetrics(workloadId)
    const syncId = `workload-sync-${container.poolId}`
    this.statusTracker.markSyncStarted(tenantId, syncId)

    const endTimer = syncDuration.startTimer({ workload_id: workloadId, direction, mode })

    try {
      // Convert WorkloadSyncMapping to the format expected by executor
      const execMapping = {
        containerPath: mapping.path,
        pattern: mapping.pattern,
        sinkPath: mapping.sinkPath ?? mapping.path.split('/').pop() ?? '',
        direction,
        mode,
      }

      const result = await this.executor.sync(
        tenantId,
        execMapping,
        syncConfig.sink,
        container.stateDir,
        initialSync,
      )

      if (result.success) {
        this.statusTracker.markSyncCompleted(tenantId, syncId)
        syncOperationsTotal.inc({ workload_id: workloadId, direction, status: 'success' })

        // Track bytes/files transferred
        if (result.bytesTransferred) {
          syncBytesTransferredTotal.inc(
            { workload_id: workloadId, direction },
            result.bytesTransferred,
          )
        }
        if (result.filesTransferred) {
          syncFilesTransferredTotal.inc(
            { workload_id: workloadId, direction },
            result.filesTransferred,
          )
        }

        this.log(
          `Success: tenant=${tenantId}, path=${mapping.path}, ` +
            `files=${result.filesTransferred ?? 0}, bytes=${result.bytesTransferred ?? 0}`,
        )
      } else {
        const errorMsg = result.errors?.join('; ') ?? 'Unknown error'
        this.statusTracker.markSyncFailed(tenantId, syncId, errorMsg, mapping.path)
        syncOperationsTotal.inc({ workload_id: workloadId, direction, status: 'failure' })
        syncErrorsTotal.inc({ workload_id: workloadId, error_type: classifySyncError(errorMsg) })

        // Track bisync resync events
        if (errorMsg.includes('--resync')) {
          syncBisyncResyncTotal.inc({ workload_id: workloadId })
        }

        this.log(`Failed: tenant=${tenantId}, path=${mapping.path}, error=${errorMsg}`)
      }

      endTimer()
      return result
    } catch (err) {
      syncOperationsTotal.inc({ workload_id: workloadId, direction, status: 'failure' })
      syncErrorsTotal.inc({ workload_id: workloadId, error_type: classifySyncError(err) })
      endTimer()
      throw err
    } finally {
      this.runningCount--
      this.updateConcurrencyMetrics(workloadId)
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
   * Log a message if verbose mode is enabled.
   */
  private log(message: string): void {
    if (this.config.verbose) {
      this._log.info(message)
    }
  }

  /**
   * Get all active periodic sync jobs.
   */
  getActiveJobs(): Array<{
    tenantId: TenantId
    interval: number
    lastSyncAt: Date
  }> {
    const jobs: Array<{
      tenantId: TenantId
      interval: number
      lastSyncAt: Date
    }> = []

    for (const job of this.periodicJobs.values()) {
      jobs.push({
        tenantId: job.tenantId,
        interval: job.interval,
        lastSyncAt: new Date(job.lastSyncAt),
      })
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
    return {
      activeJobs: this.periodicJobs.size,
      runningOperations: this.runningCount,
      pendingOperations: this.pendingQueue.length,
    }
  }

  /**
   * Stop all sync operations and clear state.
   */
  async shutdown(): Promise<void> {
    // Stop all periodic syncs
    for (const job of this.periodicJobs.values()) {
      if (job.timerId) {
        clearTimeout(job.timerId)
      }
    }
    this.periodicJobs.clear()

    // Clear pending queue
    this.pendingQueue = []

    this.log('Coordinator shutdown complete')
  }

  /**
   * Update concurrency-related metrics.
   */
  private updateConcurrencyMetrics(workloadId: WorkloadId): void {
    syncConcurrentOperations.set({ workload_id: workloadId }, this.runningCount)
    syncQueueLength.set({ workload_id: workloadId }, this.pendingQueue.length)
  }

  /**
   * Update periodic job metrics for a workload.
   */
  private updatePeriodicJobMetrics(workloadId: WorkloadId): void {
    // Count jobs for this workload
    let count = 0
    for (const job of this.periodicJobs.values()) {
      if (job.container.poolId === workloadId) {
        count++
      }
    }
    syncPeriodicJobsActive.set({ workload_id: workloadId }, count)
  }
}
