/**
 * Pools Controller
 *
 * Endpoints for managing container pools.
 */

import { PoolId, WorkloadId } from '@boilerhouse/core'
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
        const poolId = PoolId(params.id)
        const pool = poolRegistry.getPoolInfo(poolId)
        if (!pool) {
          set.status = 404
          return { error: `Pool ${poolId} not found` }
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
          const pool = poolRegistry.createPool(PoolId(body.poolId), WorkloadId(body.workloadId), {
            minIdle: body.minIdle,
            maxSize: body.maxSize,
            networks: body.networks,
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
          minIdle: t.Optional(t.Number()),
          maxSize: t.Optional(t.Number()),
          networks: t.Optional(t.Array(t.String())),
        }),
      },
    )

    .delete(
      '/:id',
      async ({ params, set }) => {
        try {
          await poolRegistry.destroyPool(PoolId(params.id))
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
        const poolId = PoolId(params.id)
        const pool = poolRegistry.getPool(poolId)
        if (!pool) {
          set.status = 404
          return { error: `Pool ${poolId} not found` }
        }

        const stats = pool.getStats()
        return {
          poolId,
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
      async ({ params, body, set }) => {
        const poolId = PoolId(params.id)
        const pool = poolRegistry.getPool(poolId)
        if (!pool) {
          set.status = 404
          return { error: `Pool ${poolId} not found` }
        }

        try {
          const stats = pool.getStats()
          const previousSize = stats.size
          const result = await pool.scaleTo(body.targetSize)
          return {
            success: true,
            previousSize,
            newSize: result.newSize,
            message: result.message,
          }
        } catch (err) {
          set.status = 400
          return { error: (err as Error).message }
        }
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
