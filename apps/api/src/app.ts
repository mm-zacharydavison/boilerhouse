/**
 * App — wires all services into a dependency graph.
 *
 * Callers own DB and runtime creation. App owns the service graph built from them.
 * Used by both the production entrypoint (index.ts) and the test harness.
 */

import type { ContainerRuntime } from '@boilerhouse/core'
import type { DrizzleDb } from '@boilerhouse/db'
import { ActivityLog } from '../lib/activity'
import {
  ContainerManager,
  type ContainerManagerConfig,
  IdleReaper,
  releaseContainer,
} from '../lib/container'
import { PoolRegistry } from '../lib/pool/registry'
import { recoverState } from '../lib/recovery'
import { RcloneSyncExecutor, SyncCoordinator, SyncStatusTracker } from '../lib/sync'
import { createWorkloadRegistry } from '../lib/workload'
import { createServer } from './server'

export interface AppConfig {
  runtime: ContainerRuntime
  db: DrizzleDb
  workloadsDir: string
  managerConfig?: Partial<ContainerManagerConfig>
  /** Whether to run recovery on start() (default: true) */
  runRecovery?: boolean
  /** Label prefix for managed containers (default: 'boilerhouse') */
  labelPrefix?: string
  /** Poll interval for idle reaper (default: 5000ms) */
  idleReaperPollIntervalMs?: number
}

export class App {
  readonly workloadRegistry: ReturnType<typeof createWorkloadRegistry>
  readonly activityLog: ActivityLog
  readonly manager: ContainerManager
  readonly poolRegistry: PoolRegistry
  readonly syncStatusTracker: SyncStatusTracker
  readonly syncCoordinator: SyncCoordinator
  readonly idleReaper: IdleReaper
  readonly server: ReturnType<typeof createServer>

  private readonly config: AppConfig

  constructor(config: AppConfig) {
    this.config = config
    const { runtime, db, workloadsDir } = config

    this.workloadRegistry = createWorkloadRegistry(workloadsDir)
    this.activityLog = new ActivityLog(db)
    this.manager = new ContainerManager(runtime, config.managerConfig)
    this.poolRegistry = new PoolRegistry(this.manager, this.workloadRegistry, this.activityLog, db)
    this.syncStatusTracker = new SyncStatusTracker(db)

    const rcloneExecutor = new RcloneSyncExecutor({ verbose: true })
    this.syncCoordinator = new SyncCoordinator(rcloneExecutor, this.syncStatusTracker, {
      verbose: true,
    })

    this.idleReaper = new IdleReaper({
      db,
      pollIntervalMs: config.idleReaperPollIntervalMs,
      onExpiry: async (_containerId, tenantId, poolId) => {
        const pool = this.poolRegistry.getPool(poolId)
        if (!pool) return
        await releaseContainer(tenantId, pool, {
          syncCoordinator: this.syncCoordinator,
          activityLog: this.activityLog,
        })
      },
    })

    this.server = createServer({
      poolRegistry: this.poolRegistry,
      workloadRegistry: this.workloadRegistry,
      containerManager: this.manager,
      syncCoordinator: this.syncCoordinator,
      syncStatusTracker: this.syncStatusTracker,
      activityLog: this.activityLog,
      idleReaper: this.idleReaper,
    })
  }

  /**
   * Run recovery, restore pools and idle reaper watches.
   * Returns recovery stats (or null if recovery was skipped).
   */
  async start() {
    let recoveryStats = null
    if (this.config.runRecovery !== false) {
      recoveryStats = await recoverState(this.config.runtime, this.config.db, {
        labelPrefix: this.config.labelPrefix ?? 'boilerhouse',
      })
    }

    this.poolRegistry.restoreFromDb()
    this.idleReaper.restoreFromDb(this.poolRegistry.getPools(), this.manager)

    return { recoveryStats }
  }

  /**
   * Graceful shutdown — stops all services. Does not close the DB (caller owns it).
   */
  async shutdown() {
    this.workloadRegistry.stopWatching()
    this.idleReaper.shutdown()
    await this.syncCoordinator.shutdown()
    this.poolRegistry.shutdown()
  }
}
