/**
 * Containers Controller
 *
 * Endpoints for listing and managing containers.
 */

import { Elysia, t } from 'elysia'
import type { PoolRegistry } from '../../lib/pool/registry'

export interface ContainersControllerDeps {
  poolRegistry: PoolRegistry
}

export function containersController(deps: ContainersControllerDeps) {
  const { poolRegistry } = deps

  return new Elysia({ prefix: '/api/v1/containers' })
    .get(
      '/',
      ({ query }) => {
        const poolId = query.poolId || undefined
        return poolRegistry.listContainersInfo(poolId)
      },
      {
        query: t.Object({
          poolId: t.Optional(t.String()),
        }),
      },
    )

    .get(
      '/:id',
      ({ params, set }) => {
        const container = poolRegistry.getContainerInfo(params.id)
        if (!container) {
          set.status = 404
          return { error: `Container ${params.id} not found` }
        }
        return container
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )

    .delete(
      '/:id',
      async ({ params, set }) => {
        const container = poolRegistry.getContainerInfo(params.id)
        if (!container) {
          set.status = 404
          return { error: `Container ${params.id} not found` }
        }

        // If assigned, release first
        if (container.tenantId) {
          const pool = poolRegistry.getPool(container.poolId)
          if (pool) {
            await pool.destroyForTenant(container.tenantId)
          }
        }

        return { success: true }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )
}
