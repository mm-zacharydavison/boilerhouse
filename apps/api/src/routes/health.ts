/**
 * Health & Stats Controller
 *
 * Endpoints for health checks, dashboard stats, and activity log.
 */

import { Elysia, t } from 'elysia'
import type { ActivityLog } from '../../lib/activity'
import type { PoolRegistry } from '../../lib/pool/registry'
import type { SyncStatusTracker } from '../../lib/sync/status'

export interface HealthControllerDeps {
  poolRegistry: PoolRegistry
  syncStatusTracker: SyncStatusTracker
  activityLog: ActivityLog
}

export function healthController(deps: HealthControllerDeps) {
  const { poolRegistry, syncStatusTracker, activityLog } = deps

  return new Elysia({ prefix: '/api/v1' })
    .get('/health', () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }))

    .get('/stats', () => {
      const poolStats = poolRegistry.getStats()
      const syncErrors = syncStatusTracker.getErrorSyncs()
      const syncPending = syncStatusTracker.getPendingSyncs()

      return {
        totalPools: poolStats.totalPools,
        totalContainers: poolStats.totalContainers,
        activeContainers: poolStats.activeContainers,
        idleContainers: poolStats.idleContainers,
        totalTenants: poolStats.totalTenants,
        syncStatus: {
          healthy: Math.max(0, poolStats.totalTenants - syncErrors.length - syncPending.length),
          warning: syncPending.length,
          error: syncErrors.length,
        },
      }
    })

    .get(
      '/activity',
      ({ query }) => {
        const limit = query.limit ? Number.parseInt(query.limit, 10) : 50
        return activityLog.getEvents(limit)
      },
      {
        query: t.Object({
          limit: t.Optional(t.String()),
        }),
      },
    )
}
