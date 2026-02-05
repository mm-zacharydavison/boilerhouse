/**
 * Workloads Controller
 *
 * Endpoints for listing and retrieving workload specifications.
 */

import { Elysia, t } from 'elysia'
import type { WorkloadRegistry } from '../../lib/workload'

export interface WorkloadsControllerDeps {
  workloadRegistry: WorkloadRegistry
}

export function workloadsController(deps: WorkloadsControllerDeps) {
  const { workloadRegistry } = deps

  return new Elysia({ prefix: '/api/v1/workloads' })
    .get('/', () => {
      return workloadRegistry.list().map((w) => ({
        id: w.id,
        name: w.name,
        image: w.image,
      }))
    })

    .get(
      '/:id',
      ({ params, set }) => {
        const workload = workloadRegistry.get(params.id)
        if (!workload) {
          set.status = 404
          return { error: `Workload ${params.id} not found` }
        }
        return workload
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )
}
