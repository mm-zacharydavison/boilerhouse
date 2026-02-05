/**
 * Recovery Module
 *
 * Reconciles database state with Docker runtime on startup.
 * Handles orphaned containers, missing containers, and restores assignments.
 */

import type { ContainerRuntime, PoolContainer } from '@boilerhouse/core'
import type { AffinityRepository, ContainerRepository } from '@boilerhouse/db'

export interface RecoveryStats {
  /** Containers restored from DB that exist in Docker */
  restored: number
  /** DB containers that no longer exist in Docker (cleaned from DB) */
  orphaned: number
  /** DB containers in Docker but stopped (removed) */
  stopped: number
  /** Docker containers not in DB (destroyed as foreign) */
  foreign: number
  /** Affinity reservations cleaned (expired) */
  expiredAffinity: number
}

export interface RecoveryConfig {
  /** Label prefix for managed containers */
  labelPrefix: string
}

/**
 * Reconcile database state with Docker runtime.
 *
 * Flow:
 * 1. Load containers from DB
 * 2. List containers from Docker with managed label
 * 3. Reconcile:
 *    - DB container exists in Docker & running → keep (restored)
 *    - DB container not in Docker → delete from DB (orphaned)
 *    - DB container in Docker but stopped → delete from DB, remove from Docker (stopped)
 *    - Docker container not in DB → destroy (foreign)
 * 4. Clean expired affinity reservations
 */
export async function recoverState(
  runtime: ContainerRuntime,
  containerRepo: ContainerRepository,
  affinityRepo: AffinityRepository,
  config: RecoveryConfig,
): Promise<RecoveryStats> {
  const stats: RecoveryStats = {
    restored: 0,
    orphaned: 0,
    stopped: 0,
    foreign: 0,
    expiredAffinity: 0,
  }

  console.log('[Recovery] Starting state recovery...')

  // 1. Load containers from DB
  const dbContainers = containerRepo.findAll()
  const dbContainerIds = new Set(dbContainers.map((c) => c.containerId))
  console.log(`[Recovery] Found ${dbContainers.length} containers in database`)

  // 2. List containers from Docker
  const dockerContainers = await runtime.listContainers({
    [`${config.labelPrefix}.managed`]: 'true',
  })
  const dockerContainerMap = new Map<string, { id: string; status: string }>()
  for (const container of dockerContainers) {
    const containerId = container.labels[`${config.labelPrefix}.container-id`]
    if (containerId) {
      dockerContainerMap.set(containerId, { id: container.id, status: container.status })
    }
  }
  console.log(`[Recovery] Found ${dockerContainerMap.size} managed containers in Docker`)

  // 3. Reconcile
  const validContainers: PoolContainer[] = []

  // Check each DB container
  for (const dbContainer of dbContainers) {
    const dockerInfo = dockerContainerMap.get(dbContainer.containerId)

    if (!dockerInfo) {
      // DB container not in Docker → orphaned
      console.log(
        `[Recovery] Container ${dbContainer.containerId} not found in Docker, removing from DB`,
      )
      containerRepo.delete(dbContainer.containerId)
      affinityRepo.deleteByContainerId(dbContainer.containerId)
      stats.orphaned++
    } else if (dockerInfo.status !== 'running') {
      // DB container in Docker but stopped → remove both
      console.log(`[Recovery] Container ${dbContainer.containerId} is stopped, removing`)
      await runtime.removeContainer(dockerInfo.id)
      containerRepo.delete(dbContainer.containerId)
      affinityRepo.deleteByContainerId(dbContainer.containerId)
      stats.stopped++
    } else {
      // Container exists and is running → keep
      validContainers.push(dbContainer)
      stats.restored++
    }
  }

  // Check for foreign containers (in Docker but not in DB)
  for (const [containerId, dockerInfo] of dockerContainerMap) {
    if (!dbContainerIds.has(containerId)) {
      console.log(`[Recovery] Container ${containerId} not in DB, destroying`)
      try {
        await runtime.destroyContainer(dockerInfo.id, 10)
      } catch (err) {
        console.error(`[Recovery] Failed to destroy foreign container ${containerId}:`, err)
      }
      stats.foreign++
    }
  }

  // 4. Clean expired affinity reservations
  stats.expiredAffinity = affinityRepo.deleteExpired()
  if (stats.expiredAffinity > 0) {
    console.log(`[Recovery] Cleaned ${stats.expiredAffinity} expired affinity reservations`)
  }

  console.log(
    `[Recovery] Complete: restored=${stats.restored}, orphaned=${stats.orphaned}, ` +
      `stopped=${stats.stopped}, foreign=${stats.foreign}, expiredAffinity=${stats.expiredAffinity}`,
  )

  return stats
}

/**
 * Restore pool state from database.
 * Called after basic recovery to set up pool tracking structures.
 */
export interface PoolRecoveryResult {
  assignedCount: number
  affinityCount: number
  idleCount: number
}
