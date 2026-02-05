/**
 * Sync Controller
 *
 * Endpoints for sync specifications, jobs, and history.
 */

import type { TenantId } from '@boilerhouse/core'
import { Elysia, t } from 'elysia'
import type { ActivityLog } from '../../lib/activity'
import type { PoolRegistry } from '../../lib/pool/registry'
import type { SyncCoordinator } from '../../lib/sync'
import type { SyncStatusTracker } from '../../lib/sync/status'
import type { WorkloadRegistry } from '../../lib/workload'

export interface SyncControllerDeps {
  poolRegistry: PoolRegistry
  workloadRegistry: WorkloadRegistry
  syncCoordinator: SyncCoordinator
  syncStatusTracker: SyncStatusTracker
  activityLog: ActivityLog
}

export function syncController(deps: SyncControllerDeps) {
  const { poolRegistry, workloadRegistry, syncCoordinator, syncStatusTracker, activityLog } = deps

  return new Elysia({ prefix: '/api/v1' })
    .get('/sync-specs', () => {
      const specs: Array<{
        id: string
        poolId: string
        mappings: Array<{
          containerPath: string
          sinkPath: string
          direction: string
        }>
        sink: {
          type: string
          bucket?: string
          region?: string
          prefix?: string
        }
        policy: {
          onClaim: boolean
          onRelease: boolean
          intervalMs?: number
        }
      }> = []

      // Gather sync specs from workloads
      for (const workload of workloadRegistry.list()) {
        if (!workload.sync) continue

        // Use pool config if defined, otherwise generate default pool ID
        const poolId = `pool-${workload.id}`

        specs.push({
          id: `sync-${workload.id}`,
          poolId,
          mappings: (workload.sync.mappings ?? []).map((m) => ({
            containerPath: m.path,
            sinkPath: m.sinkPath ?? m.path.split('/').pop() ?? '',
            direction: m.direction ?? 'bidirectional',
          })),
          sink: {
            type: workload.sync.sink.type,
            bucket: workload.sync.sink.type === 's3' ? workload.sync.sink.bucket : undefined,
            region: workload.sync.sink.type === 's3' ? workload.sync.sink.region : undefined,
            prefix: workload.sync.sink.type === 's3' ? workload.sync.sink.prefix : undefined,
          },
          policy: {
            onClaim: workload.sync.policy?.onClaim ?? true,
            onRelease: workload.sync.policy?.onRelease ?? true,
            intervalMs: workload.sync.policy?.interval,
          },
        })
      }

      return specs
    })

    .get(
      '/sync-specs/:id',
      ({ params, set }) => {
        // ID format: sync-{workloadId}
        const workloadId = params.id.replace(/^sync-/, '')
        const workload = workloadRegistry.get(workloadId)

        if (!workload?.sync) {
          set.status = 404
          return { error: `Sync spec ${params.id} not found` }
        }

        const poolId = `pool-${workload.id}`

        return {
          id: params.id,
          poolId,
          mappings: (workload.sync.mappings ?? []).map((m) => ({
            containerPath: m.path,
            sinkPath: m.sinkPath ?? m.path.split('/').pop() ?? '',
            direction: m.direction ?? 'bidirectional',
          })),
          sink: {
            type: workload.sync.sink.type,
            bucket: workload.sync.sink.type === 's3' ? workload.sync.sink.bucket : undefined,
            region: workload.sync.sink.type === 's3' ? workload.sync.sink.region : undefined,
            prefix: workload.sync.sink.type === 's3' ? workload.sync.sink.prefix : undefined,
          },
          policy: {
            onClaim: workload.sync.policy?.onClaim ?? true,
            onRelease: workload.sync.policy?.onRelease ?? true,
            intervalMs: workload.sync.policy?.interval,
          },
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .get(
      '/sync-specs/:id/status',
      ({ params }) => {
        // Gather status from all tenants using this sync spec
        const pendingSyncs = syncStatusTracker.getPendingSyncs()
        const errorSyncs = syncStatusTracker.getErrorSyncs()

        return {
          id: params.id,
          pendingCount: pendingSyncs.length,
          errorCount: errorSyncs.length,
          lastRun: null,
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .post(
      '/sync-specs/:id/trigger',
      async ({ params, set }) => {
        // ID format: sync-{workloadId}
        const workloadId = params.id.replace(/^sync-/, '')
        const workload = workloadRegistry.get(workloadId)

        if (!workload?.sync) {
          set.status = 404
          return { error: `Sync spec ${params.id} not found` }
        }

        // Find all active tenants for this workload and trigger sync
        const results: Array<{
          tenantId: TenantId
          success: boolean
          errors?: string[]
        }> = []

        for (const poolId of poolRegistry.listPoolIds()) {
          const pool = poolRegistry.getPool(poolId)
          if (!pool) continue
          if (pool.getWorkload().id !== workloadId) continue

          for (const tenantId of pool.getTenantsWithClaims()) {
            const container = pool.getContainerForTenant(tenantId)
            if (!container) continue

            const syncResults = await syncCoordinator.triggerSync(
              tenantId,
              container,
              workload.sync,
              'both',
            )

            results.push({
              tenantId,
              success: syncResults.every((r) => r.success),
              errors: syncResults.filter((r) => !r.success).flatMap((r) => r.errors ?? []),
            })
          }
        }

        return { triggered: results.length, results }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .get(
      '/sync/jobs',
      ({ query }) => {
        const pendingSyncs = syncStatusTracker.getPendingSyncs()

        const jobs = pendingSyncs.map((s) => ({
          id: `job-${s.tenantId}-${Date.now()}`,
          tenantId: s.tenantId,
          poolId: 'unknown',
          direction: 'bidirectional',
          status: 'running',
          progress: 50,
          startedAt: new Date().toISOString(),
        }))

        if (query.status) {
          return jobs.filter((j) => j.status === query.status)
        }

        return jobs
      },
      {
        query: t.Object({
          status: t.Optional(t.String()),
        }),
      },
    )

    .get(
      '/sync/history',
      ({ query }) => {
        const limit = query.limit ? Number.parseInt(query.limit, 10) : 50
        const tenantIdFilter = query.tenantId

        // Get sync-related activity events as history
        const events = activityLog.getEvents(limit * 2)
        let syncEvents = events.filter(
          (e) => e.type === 'sync.completed' || e.type === 'sync.failed',
        )

        // Filter by tenantId if provided
        if (tenantIdFilter) {
          syncEvents = syncEvents.filter((e) => e.tenantId === tenantIdFilter)
        }

        return syncEvents.slice(0, limit).map((e) => ({
          id: e.id,
          tenantId: e.tenantId ?? 'unknown',
          poolId: e.poolId ?? 'unknown',
          direction: (e.metadata?.direction as string) ?? 'bidirectional',
          status: e.type === 'sync.completed' ? 'completed' : 'failed',
          bytesTransferred: (e.metadata?.bytesTransferred as number) ?? 0,
          startedAt: e.timestamp,
          completedAt: e.timestamp,
          error: e.type === 'sync.failed' ? (e.metadata?.error as string) : undefined,
        }))
      },
      {
        query: t.Object({
          tenantId: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      },
    )
}
