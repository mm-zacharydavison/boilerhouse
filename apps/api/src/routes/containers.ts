/**
 * Containers Controller
 *
 * Endpoints for listing and managing containers.
 */

import { ContainerId, PoolId } from '@boilerhouse/core'
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
        const poolId = query.poolId ? PoolId(query.poolId) : undefined
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
        const containerId = ContainerId(params.id)
        const container = poolRegistry.getContainerInfo(containerId)
        if (!container) {
          set.status = 404
          return { error: `Container ${containerId} not found` }
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
        const containerId = ContainerId(params.id)
        const container = poolRegistry.getContainerInfo(containerId)
        if (!container) {
          set.status = 404
          return { error: `Container ${containerId} not found` }
        }

        // Cannot delete claimed containers
        if (container.status === 'claimed') {
          set.status = 400
          return { error: 'Cannot delete claimed container. Release it first.' }
        }

        const destroyed = await poolRegistry.destroyContainer(containerId)
        if (!destroyed) {
          set.status = 500
          return { error: 'Failed to destroy container' }
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
