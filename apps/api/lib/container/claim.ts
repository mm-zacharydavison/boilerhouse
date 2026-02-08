/**
 * Shared container claim flow.
 *
 * Orchestrates: acquire → sync → restart → watch.
 * Used by the API claim endpoint. Parallel to releaseContainer.
 */

import type { PoolContainer, PoolId, TenantId } from '@boilerhouse/core'
import { type ActivityLog, logContainerClaimed, logSyncStarted } from '../activity'
import type { SyncCoordinator } from '../sync'
import { logSyncResults } from '../sync/logging'
import type { IdleReaper } from './idle-reaper'
import type { ContainerManager } from './manager'
import type { ContainerPool } from './pool'

export interface ClaimContainerDeps {
  containerManager: ContainerManager
  syncCoordinator: SyncCoordinator
  activityLog: ActivityLog
  idleReaper: IdleReaper
}

export interface ClaimResult {
  container: PoolContainer
  hostname: string
}

/**
 * Acquire a container for a tenant, sync state, restart, and start idle watch.
 */
export async function claimContainer(
  tenantId: TenantId,
  poolId: PoolId,
  pool: ContainerPool,
  deps: ClaimContainerDeps,
): Promise<ClaimResult> {
  const { containerManager, syncCoordinator, activityLog, idleReaper } = deps

  // Wipe-on-entry happens inside acquireForTenant when a different tenant
  // claims a container. Same tenant reclaiming skips the wipe.
  const container = await pool.acquireForTenant(tenantId)
  logContainerClaimed(container.containerId, tenantId, poolId, activityLog)

  // Determine if this tenant is returning to their previous container.
  // If so, state is intact → incremental bisync. Otherwise → full download.
  const isReturningTenant = container.lastTenantId === tenantId

  // Trigger onClaim sync
  const workload = pool.getWorkload()
  if (workload.sync) {
    logSyncStarted(tenantId, isReturningTenant ? 'bisync' : 'download', activityLog)
    const results = await syncCoordinator.onClaim(
      tenantId,
      container,
      workload.sync,
      !isReturningTenant,
    )
    logSyncResults(tenantId, results, activityLog)
  }

  // Restart container to get fresh process with synced data
  // Use short timeout (2s) - if process doesn't handle SIGTERM, just kill it
  await containerManager.restartContainer(container.containerId, 2)

  // Start filesystem idle TTL watch if configured
  const fileIdleTtl = pool.getConfig().fileIdleTtl
  if (fileIdleTtl) {
    idleReaper.watch(container.containerId, tenantId, poolId, container.stateDir, fileIdleTtl)
  }

  const hostname = containerManager.getHostname(container.containerId)
  return { container, hostname }
}
