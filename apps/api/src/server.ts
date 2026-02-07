/**
 * Boilerhouse API Server
 *
 * Elysia-based REST API for managing container pools, tenants, and sync.
 */

import { cors } from '@elysiajs/cors'
import { opentelemetry } from '@elysiajs/opentelemetry'
import { Elysia } from 'elysia'
import type { ActivityLog } from '../lib/activity'
import type { ContainerManager, IdleReaper } from '../lib/container'
import { isDomainError } from '../lib/errors'
import type { Logger } from '../lib/logger'
import { httpMetricsMiddleware } from '../lib/metrics'
import type { PoolRegistry } from '../lib/pool/registry'
import type { SyncCoordinator } from '../lib/sync'
import type { SyncStatusTracker } from '../lib/sync/status'
import type { WorkloadRegistry } from '../lib/workload'
import {
  containersController,
  healthController,
  metricsController,
  poolsController,
  syncController,
  tenantsController,
  workloadsController,
} from './routes'

/**
 * Dependencies for the API server
 */
export interface ServerDependencies {
  poolRegistry: PoolRegistry
  workloadRegistry: WorkloadRegistry
  containerManager: ContainerManager
  syncCoordinator: SyncCoordinator
  syncStatusTracker: SyncStatusTracker
  activityLog: ActivityLog
  idleReaper: IdleReaper
  logger?: Logger
}

/**
 * Create the Elysia API server
 */
export function createServer(deps: ServerDependencies) {
  const {
    poolRegistry,
    workloadRegistry,
    containerManager,
    syncCoordinator,
    syncStatusTracker,
    activityLog,
    idleReaper,
    logger,
  } = deps

  return new Elysia()
    .use(cors())
    .use(opentelemetry())
    .use(httpMetricsMiddleware)
    .onError(({ error, set }) => {
      if (isDomainError(error)) {
        set.status = error.status
        return { error: error.message }
      }
      if (error instanceof Error) {
        set.status = 500
        return { error: error.message }
      }
      set.status = 500
      return { error: 'Internal server error' }
    })
    .use(metricsController())
    .use(healthController({ poolRegistry, syncStatusTracker, activityLog }))
    .use(workloadsController({ workloadRegistry }))
    .use(poolsController({ poolRegistry }))
    .use(containersController({ poolRegistry }))
    .use(
      tenantsController({
        poolRegistry,
        containerManager,
        syncCoordinator,
        syncStatusTracker,
        activityLog,
        idleReaper,
      }),
    )
    .use(
      syncController({
        poolRegistry,
        workloadRegistry,
        syncCoordinator,
        syncStatusTracker,
        activityLog,
      }),
    )
}
