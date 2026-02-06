/**
 * Metrics Route
 *
 * Prometheus metrics endpoint for scraping.
 */

import { Elysia } from 'elysia'
import { registry } from '../../lib/metrics'

export const metricsController = () =>
  new Elysia({ prefix: '' }).get('/metrics', async () => {
    const metrics = await registry.metrics()
    return new Response(metrics, {
      headers: { 'Content-Type': registry.contentType },
    })
  })
