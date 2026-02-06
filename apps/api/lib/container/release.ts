/**
 * Shared container release flow.
 *
 * Syncs state to remote storage (if configured) then releases the container
 * back to the pool. Used by both the API release endpoint and the idle reaper.
 */

import type { TenantId } from '@boilerhouse/core'
import {
  type ActivityLog,
  logContainerReleased,
  logSyncCompleted,
  logSyncFailed,
  logSyncStarted,
} from '../activity'
import type { SyncCoordinator } from '../sync'
import type { ContainerPool } from './pool'

export interface ReleaseContainerDeps {
  syncCoordinator: SyncCoordinator
  activityLog: ActivityLog
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
  const { syncCoordinator, activityLog } = deps

  const container = pool.getContainerForTenant(tenantId)
  if (!container) return

  const workload = pool.getWorkload()
  if (opts?.skipSync !== true && workload.sync) {
    logSyncStarted(tenantId, 'upload', activityLog)
    const results = await syncCoordinator.onRelease(tenantId, container, workload.sync)
    const totalBytes = results.reduce((sum, r) => sum + (r.bytesTransferred ?? 0), 0)
    if (results.every((r) => r.success)) {
      logSyncCompleted(tenantId, totalBytes, activityLog)
    } else {
      const errors = results.filter((r) => !r.success).flatMap((r) => r.errors ?? [])
      logSyncFailed(tenantId, errors.join('; '), activityLog)
    }
  }

  logContainerReleased(container.containerId, tenantId, pool.getPoolId(), activityLog)
  await pool.releaseForTenant(tenantId)
}
