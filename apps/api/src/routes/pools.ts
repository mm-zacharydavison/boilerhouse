/**
 * Pools Controller
 *
 * Endpoints for managing container pools.
 */

import { Elysia, t } from 'elysia'
import type { PoolRegistry } from '../../lib/pool/registry'

export interface PoolsControllerDeps {
  poolRegistry: PoolRegistry
}

export function poolsController(deps: PoolsControllerDeps) {
  const { poolRegistry } = deps

  return new Elysia({ prefix: '/api/v1/pools' })
    .get('/', () => {
      return poolRegistry.listPoolsInfo()
    })

    .get(
      '/:id',
      ({ params, set }) => {
        const pool = poolRegistry.getPoolInfo(params.id)
        if (!pool) {
          set.status = 404
          return { error: `Pool ${params.id} not found` }
        }
        return pool
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .post(
      '/',
      async ({ body, set }) => {
        try {
          const pool = poolRegistry.createPool(body.poolId, body.workloadId, {
            minSize: body.minSize,
            maxSize: body.maxSize,
          })
          return poolRegistry.getPoolInfo(pool.getPoolId())
        } catch (err) {
          set.status = 400
          return { error: (err as Error).message }
        }
      },
      {
        body: t.Object({
          poolId: t.String(),
          workloadId: t.String(),
          minSize: t.Optional(t.Number()),
          maxSize: t.Optional(t.Number()),
        }),
      },
    )

    .delete(
      '/:id',
      async ({ params, set }) => {
        try {
          await poolRegistry.destroyPool(params.id)
          return { success: true }
        } catch (err) {
          set.status = 404
          return { error: (err as Error).message }
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .get(
      '/:id/metrics',
      ({ params, set }) => {
        const pool = poolRegistry.getPool(params.id)
        if (!pool) {
          set.status = 404
          return { error: `Pool ${params.id} not found` }
        }

        const stats = pool.getStats()
        return {
          poolId: params.id,
          cpuUsagePercent: 0,
          memoryUsagePercent: 0,
          claimLatencyMs: 0,
          releaseLatencyMs: 0,
          containersCreated24h: stats.size,
          containersDestroyed24h: 0,
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .post(
      '/:id/scale',
      async ({ params, set }) => {
        const pool = poolRegistry.getPool(params.id)
        if (!pool) {
          set.status = 404
          return { error: `Pool ${params.id} not found` }
        }

        // Note: generic-pool doesn't support runtime resize.
        return { success: true, message: 'Scaling not implemented yet' }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          targetSize: t.Number(),
        }),
      },
    )
}
