/**
 * Recovery Module
 *
 * Reconciles DB state with Docker runtime on startup.
 * Docker is the source of truth for container existence.
 * DB is the source of truth for domain state (claims, affinity).
 *
 * Flow:
 * 1. List Docker containers with managed label (Docker = truth for existence)
 * 2. Clean up claims for containers NOT in Docker (stale rows)
 * 3. Clean up affinity reservations for containers NOT in Docker
 * 4. Clean up expired affinity reservations
 */

import type { ContainerRuntime } from '@boilerhouse/core'
import type { AffinityRepository, ClaimRepository } from '@boilerhouse/db'

export interface RecoveryStats {
  /** Docker containers found with managed label */
  dockerContainers: number
  /** Stale claim rows cleaned (container not in Docker) */
  staleClaims: number
  /** Stale affinity rows cleaned (container not in Docker) */
  staleAffinity: number
  /** Affinity reservations cleaned (expired) */
  expiredAffinity: number
}

export interface RecoveryConfig {
  /** Label prefix for managed containers */
  labelPrefix: string
}

/**
 * Reconcile DB state with Docker runtime.
 */
export async function recoverState(
  runtime: ContainerRuntime,
  claimRepo: ClaimRepository,
  affinityRepo: AffinityRepository,
  config: RecoveryConfig,
): Promise<RecoveryStats> {
  const stats: RecoveryStats = {
    dockerContainers: 0,
    staleClaims: 0,
    staleAffinity: 0,
    expiredAffinity: 0,
  }

  console.log('[Recovery] Starting state recovery...')

  // 1. List Docker containers with managed label (Docker = source of truth)
  const dockerContainers = await runtime.listContainers({
    [`${config.labelPrefix}.managed`]: 'true',
  })
  const dockerContainerIds = new Set<string>()
  for (const container of dockerContainers) {
    const containerId = container.labels[`${config.labelPrefix}.container-id`]
    if (containerId && container.status === 'running') {
      dockerContainerIds.add(containerId)
    } else if (containerId && container.status !== 'running') {
      // Remove stopped containers from Docker
      console.log(`[Recovery] Removing stopped container ${containerId}`)
      try {
        await runtime.removeContainer(container.id)
      } catch (err) {
        console.error(`[Recovery] Failed to remove stopped container ${containerId}:`, err)
      }
    }
  }
  stats.dockerContainers = dockerContainerIds.size
  console.log(`[Recovery] Found ${dockerContainerIds.size} running managed containers in Docker`)

  // 2. Clean up claims for containers NOT in Docker
  const claims = claimRepo.findAll()
  for (const claim of claims) {
    if (!dockerContainerIds.has(claim.containerId)) {
      console.log(`[Recovery] Cleaning stale claim for container ${claim.containerId}`)
      claimRepo.delete(claim.containerId)
      stats.staleClaims++
    }
  }

  // 3. Clean up affinity reservations for containers NOT in Docker
  const affinityReservations = affinityRepo.findAll()
  for (const reservation of affinityReservations) {
    if (!dockerContainerIds.has(reservation.containerId)) {
      console.log(`[Recovery] Cleaning stale affinity for container ${reservation.containerId}`)
      affinityRepo.delete(reservation.tenantId)
      stats.staleAffinity++
    }
  }

  // 4. Clean expired affinity reservations
  stats.expiredAffinity = affinityRepo.deleteExpired()
  if (stats.expiredAffinity > 0) {
    console.log(`[Recovery] Cleaned ${stats.expiredAffinity} expired affinity reservations`)
  }

  console.log(
    `[Recovery] Complete: docker=${stats.dockerContainers}, staleClaims=${stats.staleClaims}, ` +
      `staleAffinity=${stats.staleAffinity}, expiredAffinity=${stats.expiredAffinity}`,
  )

  return stats
}

/**
 * Restore pool state from database.
 * Called after basic recovery to set up pool tracking structures.
 */
export interface PoolRecoveryResult {
  claimedCount: number
  affinityCount: number
  idleCount: number
}
