/**
 * Recovery Module
 *
 * Reconciles DB state with Docker runtime on startup.
 * Docker is the source of truth for container existence.
 * DB is the source of truth for domain state (status, claims).
 *
 * Flow:
 * 1. List Docker containers with managed label (Docker = truth for existence)
 * 2. Clean up container rows for containers NOT in Docker (stale rows)
 */

import type { ContainerRuntime } from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { eq } from 'drizzle-orm'

export interface RecoveryStats {
  /** Docker containers found with managed label */
  dockerContainers: number
  /** Stale container rows cleaned (container not in Docker) */
  staleContainers: number
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
  db: DrizzleDb,
  config: RecoveryConfig,
): Promise<RecoveryStats> {
  const stats: RecoveryStats = {
    dockerContainers: 0,
    staleContainers: 0,
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

  // 2. Clean up container rows for containers NOT in Docker
  const allContainerRows = db.select().from(schema.containers).all()
  for (const row of allContainerRows) {
    if (!dockerContainerIds.has(row.containerId)) {
      console.log(`[Recovery] Cleaning stale container row for ${row.containerId}`)
      db.delete(schema.containers).where(eq(schema.containers.containerId, row.containerId)).run()
      stats.staleContainers++
    }
  }

  console.log(
    `[Recovery] Complete: docker=${stats.dockerContainers}, staleContainers=${stats.staleContainers}`,
  )

  return stats
}
