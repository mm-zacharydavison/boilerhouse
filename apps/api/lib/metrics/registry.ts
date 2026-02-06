/**
 * Prometheus Registry
 *
 * Central registry for all metrics. Separated to avoid circular imports.
 */

import { Gauge, Registry, collectDefaultMetrics } from 'prom-client'

// Create a custom registry (allows isolation in tests)
export const registry = new Registry()

// Add default Node.js metrics (process CPU, memory, event loop lag, etc.)
collectDefaultMetrics({ register: registry })

// System info gauge
export const systemInfo = new Gauge({
  name: 'boilerhouse_info',
  help: 'Static info about the Boilerhouse instance',
  labelNames: ['version'],
  registers: [registry],
})
systemInfo.set({ version: '0.1.0' }, 1)

// Process start time
export const startTime = new Gauge({
  name: 'boilerhouse_start_time_seconds',
  help: 'Unix timestamp when the process started',
  registers: [registry],
})
startTime.set(Math.floor(Date.now() / 1000))
