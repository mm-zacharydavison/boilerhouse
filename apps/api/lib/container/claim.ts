/**
 * Shared container claim flow.
 *
 * Orchestrates: acquire → sync → [restart] → watch.
 * Used by the API claim endpoint. Parallel to releaseContainer.
 */

import type { PoolContainer, PoolId, TenantId } from '@boilerhouse/core'
import { type ActivityLog, logContainerClaimed, logSyncStarted } from '../activity'
import type { SyncCoordinator } from '../sync'
import { logSyncResults } from '../sync/logging'
import { HookError, runHooks } from './hooks'
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

  // Trigger onClaim sync
  const workload = pool.getWorkload()
  if (workload.sync) {
    logSyncStarted(tenantId, 'download', activityLog)
    const results = await syncCoordinator.onClaim(tenantId, container, workload.sync)
    logSyncResults(tenantId, results, activityLog)
  }

  // Seed on first claim only.
  // - Sync workloads: seed once, then sync handles data persistence.
  // - Non-sync workloads: seed when container was wiped (different tenant).
  //   Returning tenants (affinity match) keep their existing data.
  const isFirstClaim = workload.sync
    ? !syncCoordinator.hasSyncedBefore(tenantId, container.poolId)
    : container.lastTenantId !== tenantId
  if (isFirstClaim) {
    await containerManager.applySeed(container.containerId, workload)
  }

  // Run post_claim hooks (after container is healthy and ready)
  if (workload.hooks?.postClaim) {
    const hookResult = await runHooks(
      'post_claim',
      workload.hooks.postClaim,
      container.containerId,
      containerManager.getRuntime(),
      activityLog,
    )
    if (hookResult.aborted) {
      await pool.releaseForTenant(tenantId)
      throw new HookError('post_claim', hookResult)
    }
  }

  // Start filesystem idle TTL watch if configured
  const fileIdleTtl = pool.getConfig().fileIdleTtl
  if (fileIdleTtl) {
    idleReaper.watch(container.containerId, tenantId, poolId, container.stateDir, fileIdleTtl)
  }

  const hostname = containerManager.getHostname(container.containerId)
  return { container, hostname }
}
