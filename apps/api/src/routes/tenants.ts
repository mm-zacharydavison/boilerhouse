/**
 * Tenants Controller
 *
 * Endpoints for tenant operations: listing, claiming, releasing, and syncing.
 */

import type { PoolId, TenantId } from '@boilerhouse/core'
import { Elysia, t } from 'elysia'
import { type ActivityLog, logSyncStarted } from '../../lib/activity'
import {
  type ContainerManager,
  type IdleReaper,
  claimContainer,
  releaseContainer,
} from '../../lib/container'
import {
  ContainerNotFoundError,
  PoolNotFoundError,
  SyncNotConfiguredError,
  TenantNotFoundError,
} from '../../lib/errors'
import type { PoolRegistry } from '../../lib/pool/registry'
import type { SyncCoordinator } from '../../lib/sync'
import { logSyncResults } from '../../lib/sync/logging'
import type { SyncStatusTracker } from '../../lib/sync/status'

export interface TenantsControllerDeps {
  poolRegistry: PoolRegistry
  containerManager: ContainerManager
  syncCoordinator: SyncCoordinator
  syncStatusTracker: SyncStatusTracker
  activityLog: ActivityLog
  idleReaper: IdleReaper
}

export function tenantsController(deps: TenantsControllerDeps) {
  const {
    poolRegistry,
    containerManager,
    syncCoordinator,
    syncStatusTracker,
    activityLog,
    idleReaper,
  } = deps

  return new Elysia({ prefix: '/api/v1/tenants' })
    .get('/', () => {
      const tenants: Array<{
        id: TenantId
        poolId: string | null
        containerId: string | null
        status: 'active' | 'pending' | 'releasing' | 'idle'
        claimedAt: string | null
        lastActivityAt: string | null
        syncStatus: ReturnType<typeof syncStatusTracker.getStatusesForTenant>[0] | null
      }> = []

      // Gather tenants from all pools
      for (const poolId of poolRegistry.listPoolIds()) {
        const pool = poolRegistry.getPool(poolId)
        if (!pool) continue

        for (const tenantId of pool.getTenantsWithClaims()) {
          const container = pool.getContainerForTenant(tenantId)
          const syncStatuses = syncStatusTracker.getStatusesForTenant(tenantId)

          tenants.push({
            id: tenantId,
            poolId,
            containerId: container?.containerId ?? null,
            status: container?.status === 'claimed' ? 'active' : 'pending',
            claimedAt: container?.lastActivity.toISOString() ?? null,
            lastActivityAt: container?.lastActivity.toISOString() ?? null,
            syncStatus: syncStatuses[0] ?? null,
          })
        }
      }

      return tenants
    })

    .get(
      '/:id',
      ({ params }) => {
        const pool = poolRegistry.getPoolForTenant(params.id)
        if (!pool) {
          throw new TenantNotFoundError(params.id)
        }

        const container = pool.getContainerForTenant(params.id)
        const syncStatuses = syncStatusTracker.getStatusesForTenant(params.id)

        return {
          id: params.id,
          poolId: pool.getPoolId(),
          containerId: container?.containerId ?? null,
          status: container?.status === 'claimed' ? 'active' : 'pending',
          claimedAt: container?.lastActivity.toISOString() ?? null,
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
          status: container?.status === 'claimed' ? 'warm' : 'provisioning',
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
      async ({ params, body }) => {
        const pool = poolRegistry.getPool(body.poolId)
        if (!pool) {
          throw new PoolNotFoundError(body.poolId)
        }

        const { container } = await claimContainer(
          params.id as TenantId,
          body.poolId as PoolId,
          pool,
          { containerManager, syncCoordinator, activityLog, idleReaper },
        )

        return {
          containerId: container.containerId,
          endpoints: {
            socket: container.socketPath,
          },
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
      async ({ params, body }) => {
        const pool = poolRegistry.getPoolForTenant(params.id)
        if (!pool) {
          throw new TenantNotFoundError(params.id)
        }

        const container = pool.getContainerForTenant(params.id)
        if (!container) {
          throw new ContainerNotFoundError(`No container for tenant ${params.id}`)
        }

        // Stop filesystem idle watch before release
        idleReaper.unwatch(container.containerId)

        await releaseContainer(
          params.id,
          pool,
          { syncCoordinator, activityLog },
          {
            skipSync: body.sync === false,
          },
        )

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
      async ({ params, body }) => {
        const pool = poolRegistry.getPoolForTenant(params.id)
        if (!pool) {
          throw new TenantNotFoundError(params.id)
        }

        const container = pool.getContainerForTenant(params.id)
        if (!container) {
          throw new ContainerNotFoundError(`No container for tenant ${params.id}`)
        }

        const workload = pool.getWorkload()
        if (!workload.sync) {
          throw new SyncNotConfiguredError()
        }

        logSyncStarted(params.id, body.direction ?? 'both', activityLog)
        const results = await syncCoordinator.triggerSync(
          params.id,
          container,
          workload.sync,
          body.direction ?? 'both',
        )

        const { hasErrors } = logSyncResults(params.id, results, activityLog)

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
