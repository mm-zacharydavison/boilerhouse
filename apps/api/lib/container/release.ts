/**
 * Shared container release flow.
 *
 * Syncs state to remote storage (if configured) then releases the container
 * back to the pool. Used by both the API release endpoint and the idle reaper.
 */

import type { TenantId } from '@boilerhouse/core'
import { type ActivityLog, logContainerReleased, logSyncStarted } from '../activity'
import type { SyncCoordinator } from '../sync'
import { logSyncResults } from '../sync/logging'
import { runHooks } from './hooks'
import type { ContainerManager } from './manager'
import type { ContainerPool } from './pool'

export interface ReleaseContainerDeps {
  syncCoordinator: SyncCoordinator
  activityLog: ActivityLog
  containerManager: ContainerManager
}

export interface ReleaseContainerOpts {
  /** Skip the upload sync (default: false) */
  skipSync?: boolean
}

/**
 * Sync (if configured) then release a container back to the pool.
 */
export async function releaseContainer(
  tenantId: TenantId,
  pool: ContainerPool,
  deps: ReleaseContainerDeps,
  opts?: ReleaseContainerOpts,
): Promise<void> {
  const { syncCoordinator, activityLog, containerManager } = deps

  const container = pool.getContainerForTenant(tenantId)
  if (!container) return

  const workload = pool.getWorkload()

  // Run pre_release hooks (while container is still claimed and running)
  if (workload.hooks?.preRelease) {
    const hookResult = await runHooks(
      'pre_release',
      workload.hooks.preRelease,
      container.containerId,
      containerManager.getRuntime(),
      activityLog,
    )
    if (hookResult.aborted) {
      // Log warning but continue release — can't leave container half-released
      activityLog.log(
        'hook.failed',
        `pre_release hooks aborted but release will proceed for tenant ${tenantId}`,
        { tenantId, containerId: container.containerId },
      )
    }
  }

  if (opts?.skipSync !== true && workload.sync) {
    logSyncStarted(tenantId, 'upload', activityLog)
    const results = await syncCoordinator.onRelease(tenantId, container, workload.sync)
    logSyncResults(tenantId, results, activityLog)
  }

  logContainerReleased(container.containerId, tenantId, pool.getPoolId(), activityLog)
  await pool.releaseForTenant(tenantId)
}
