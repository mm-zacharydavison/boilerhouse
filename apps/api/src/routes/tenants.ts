/**
 * Tenants Controller
 *
 * Endpoints for tenant operations: listing, claiming, releasing, and syncing.
 */

import type { TenantId } from '@boilerhouse/core'
import { Elysia, t } from 'elysia'
import {
  type ActivityLog,
  logContainerClaimed,
  logContainerReleased,
  logSyncCompleted,
  logSyncFailed,
  logSyncStarted,
} from '../../lib/activity'
import type { ContainerManager } from '../../lib/container'
import type { PoolRegistry } from '../../lib/pool/registry'
import type { SyncCoordinator } from '../../lib/sync'
import type { SyncStatusTracker } from '../../lib/sync/status'

export interface TenantsControllerDeps {
  poolRegistry: PoolRegistry
  containerManager: ContainerManager
  syncCoordinator: SyncCoordinator
  syncStatusTracker: SyncStatusTracker
  activityLog: ActivityLog
}

export function tenantsController(deps: TenantsControllerDeps) {
  const { poolRegistry, containerManager, syncCoordinator, syncStatusTracker, activityLog } = deps

  return new Elysia({ prefix: '/api/v1/tenants' })
    .get('/', () => {
      const tenants: Array<{
        id: TenantId
        poolId: string | null
        containerId: string | null
        status: 'active' | 'pending' | 'releasing' | 'idle'
        assignedAt: string | null
        lastActivityAt: string | null
        syncStatus: ReturnType<typeof syncStatusTracker.getStatusesForTenant>[0] | null
      }> = []

      // Gather tenants from all pools
      for (const poolId of poolRegistry.listPoolIds()) {
        const pool = poolRegistry.getPool(poolId)
        if (!pool) continue

        for (const tenantId of pool.getAssignedTenants()) {
          const container = pool.getContainerForTenant(tenantId)
          const syncStatuses = syncStatusTracker.getStatusesForTenant(tenantId)

          tenants.push({
            id: tenantId,
            poolId,
            containerId: container?.containerId ?? null,
            status: container?.status === 'assigned' ? 'active' : 'pending',
            assignedAt: container?.lastActivity.toISOString() ?? null,
            lastActivityAt: container?.lastActivity.toISOString() ?? null,
            syncStatus: syncStatuses[0] ?? null,
          })
        }
      }

      return tenants
    })

    .get(
      '/:id',
      ({ params, set }) => {
        const pool = poolRegistry.getPoolForTenant(params.id)
        if (!pool) {
          set.status = 404
          return { error: `Tenant ${params.id} not found` }
        }

        const container = pool.getContainerForTenant(params.id)
        const syncStatuses = syncStatusTracker.getStatusesForTenant(params.id)

        return {
          id: params.id,
          poolId: pool.getPoolId(),
          containerId: container?.containerId ?? null,
          status: container?.status === 'assigned' ? 'active' : 'pending',
          assignedAt: container?.lastActivity.toISOString() ?? null,
          lastActivityAt: container?.lastActivity.toISOString() ?? null,
          syncStatus: syncStatuses[0] ?? null,
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .get(
      '/:id/status',
      ({ params }) => {
        const pool = poolRegistry.getPoolForTenant(params.id)
        const container = poolRegistry.getContainerForTenant(params.id)
        const syncStatuses = syncStatusTracker.getStatusesForTenant(params.id)

        if (!pool && !container) {
          return {
            status: 'cold',
            syncStatus: syncStatuses[0] ?? null,
          }
        }

        return {
          status: container?.status === 'assigned' ? 'warm' : 'provisioning',
          containerId: container?.containerId,
          poolId: pool?.getPoolId(),
          lastActivity: container?.lastActivity.toISOString(),
          syncStatus: syncStatuses[0] ?? null,
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .post(
      '/:id/claim',
      async ({ params, body, set }) => {
        const pool = poolRegistry.getPool(body.poolId)
        if (!pool) {
          set.status = 404
          return { error: `Pool ${body.poolId} not found` }
        }

        try {
          const { container, isAffinityMatch } = await pool.acquireForTenant(params.id)
          logContainerClaimed(container.containerId, params.id, body.poolId, activityLog)

          // If this is a new container (not tenant's previous), wipe it first
          if (!isAffinityMatch) {
            await containerManager.wipeForNewTenant(container.containerId)
          }

          // Trigger onClaim sync
          // initialSync=true for new containers (full download with --resync)
          // initialSync=false for affinity match (incremental bisync)
          const workload = pool.getWorkload()
          if (workload.sync) {
            logSyncStarted(params.id, isAffinityMatch ? 'bisync' : 'download', activityLog)
            const results = await syncCoordinator.onClaim(
              params.id,
              container,
              workload.sync,
              !isAffinityMatch,
            )
            const totalBytes = results.reduce((sum, r) => sum + (r.bytesTransferred ?? 0), 0)
            if (results.every((r) => r.success)) {
              logSyncCompleted(params.id, totalBytes, activityLog)
            } else {
              const errors = results.filter((r) => !r.success).flatMap((r) => r.errors ?? [])
              logSyncFailed(params.id, errors.join('; '), activityLog)
            }
          }

          // Restart container to get fresh process with synced data
          await containerManager.restartContainer(container.containerId)

          return {
            containerId: container.containerId,
            endpoints: {
              socket: container.socketPath,
            },
          }
        } catch (err) {
          set.status = 500
          return { error: (err as Error).message }
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          poolId: t.String(),
          metadata: t.Optional(t.Record(t.String(), t.Unknown())),
        }),
      },
    )

    .post(
      '/:id/release',
      async ({ params, body, set }) => {
        const pool = poolRegistry.getPoolForTenant(params.id)
        if (!pool) {
          set.status = 404
          return { error: `Tenant ${params.id} not found` }
        }

        const container = pool.getContainerForTenant(params.id)
        if (!container) {
          set.status = 404
          return { error: `No container for tenant ${params.id}` }
        }

        // Trigger onRelease sync if requested
        const workload = pool.getWorkload()
        if (body.sync !== false && workload.sync) {
          logSyncStarted(params.id, 'upload', activityLog)
          const results = await syncCoordinator.onRelease(params.id, container, workload.sync)
          const totalBytes = results.reduce((sum, r) => sum + (r.bytesTransferred ?? 0), 0)
          if (results.every((r) => r.success)) {
            logSyncCompleted(params.id, totalBytes, activityLog)
          } else {
            const errors = results.filter((r) => !r.success).flatMap((r) => r.errors ?? [])
            logSyncFailed(params.id, errors.join('; '), activityLog)
          }
        }

        logContainerReleased(container.containerId, params.id, pool.getPoolId(), activityLog)
        await pool.releaseForTenant(params.id)

        return { success: true }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          sync: t.Optional(t.Boolean()),
        }),
      },
    )

    .post(
      '/:id/sync',
      async ({ params, body, set }) => {
        const pool = poolRegistry.getPoolForTenant(params.id)
        if (!pool) {
          set.status = 404
          return { error: `Tenant ${params.id} not found` }
        }

        const container = pool.getContainerForTenant(params.id)
        if (!container) {
          set.status = 404
          return { error: `No container for tenant ${params.id}` }
        }

        const workload = pool.getWorkload()
        if (!workload.sync) {
          set.status = 400
          return { error: 'No sync configuration for this workload' }
        }

        logSyncStarted(params.id, body.direction ?? 'both', activityLog)
        const results = await syncCoordinator.triggerSync(
          params.id,
          container,
          workload.sync,
          body.direction ?? 'both',
        )

        const totalBytes = results.reduce((sum, r) => sum + (r.bytesTransferred ?? 0), 0)
        const hasErrors = results.some((r) => !r.success)

        if (hasErrors) {
          const errors = results.filter((r) => !r.success).flatMap((r) => r.errors ?? [])
          logSyncFailed(params.id, errors.join('; '), activityLog)
        } else {
          logSyncCompleted(params.id, totalBytes, activityLog)
        }

        return {
          success: !hasErrors,
          results: results.map((r) => ({
            success: r.success,
            bytesTransferred: r.bytesTransferred,
            filesTransferred: r.filesTransferred,
            errors: r.errors,
          })),
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          direction: t.Optional(
            t.Union([t.Literal('upload'), t.Literal('download'), t.Literal('both')]),
          ),
        }),
      },
    )
}
