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
import type { Logger } from '../logger'

export interface RecoveryStats {
  /** Docker containers found with managed label */
  dockerContainers: number
  /** Stale container rows cleaned (container not in Docker) */
  staleContainers: number
}

export interface RecoveryConfig {
  /** Label prefix for managed containers */
  labelPrefix: string
  /** Logger instance */
  logger: Logger
}

/**
 * Reconcile DB state with Docker runtime.
 */
export async function recoverState(
  runtime: ContainerRuntime,
  db: DrizzleDb,
  config: RecoveryConfig,
): Promise<RecoveryStats> {
  const log = config.logger.child({ component: 'Recovery' })
  const stats: RecoveryStats = {
    dockerContainers: 0,
    staleContainers: 0,
  }

  log.info('Starting state recovery...')

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
      log.info({ containerId }, 'Removing stopped container')
      try {
        await runtime.removeContainer(container.id)
      } catch (err) {
        log.error({ err, containerId }, 'Failed to remove stopped container')
      }
    }
  }
  stats.dockerContainers = dockerContainerIds.size
  log.info({ count: dockerContainerIds.size }, 'Found running managed containers in Docker')

  // 2. Clean up container rows for containers NOT in Docker
  const allContainerRows = db.select().from(schema.containers).all()
  for (const row of allContainerRows) {
    if (!dockerContainerIds.has(row.containerId)) {
      log.info({ containerId: row.containerId }, 'Cleaning stale container row')
      db.delete(schema.containers).where(eq(schema.containers.containerId, row.containerId)).run()
      stats.staleContainers++
    }
  }

  log.info(
    { dockerContainers: stats.dockerContainers, staleContainers: stats.staleContainers },
    'Recovery complete',
  )

  return stats
}
