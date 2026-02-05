/**
 * Boilerhouse API Server
 *
 * Elysia-based REST API for managing container pools, tenants, and sync.
 */

import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import type { ActivityLog } from '../lib/activity'
import type { ContainerManager } from '../lib/container'
import type { PoolRegistry } from '../lib/pool/registry'
import type { SyncCoordinator } from '../lib/sync'
import type { SyncStatusTracker } from '../lib/sync/status'
import type { WorkloadRegistry } from '../lib/workload'
import {
  containersController,
  healthController,
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
  } = deps

  return new Elysia()
    .use(cors())
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
