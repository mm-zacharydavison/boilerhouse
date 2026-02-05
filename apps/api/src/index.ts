import type { PoolId, WorkloadId } from '@boilerhouse/core'
import { DockerRuntime } from '@boilerhouse/docker'
import { config } from '../lib/config'
import { ContainerManager, ContainerPool } from '../lib/container'
import { createWorkloadRegistry } from '../lib/workload'

const DEFAULT_POOL_ID = 'default-pool' as PoolId
const DEFAULT_WORKLOAD_ID = 'default' as WorkloadId

console.log('Starting Boilerhouse API server...')
console.log('Configuration:')
console.log(`  - Pool size: ${config.pool.minPoolSize}`)
console.log(`  - Max containers: ${config.pool.maxContainersPerNode}`)
console.log(`  - API: ${config.apiHost}:${config.apiPort}`)
console.log(`  - Workloads dir: ${config.workloadsDir}`)

// Load workloads from YAML files
const workloadRegistry = createWorkloadRegistry(config.workloadsDir)
console.log(`  - Loaded ${workloadRegistry.size} workload(s): ${workloadRegistry.ids().join(', ')}`)

const defaultWorkload = workloadRegistry.get(DEFAULT_WORKLOAD_ID)
if (!defaultWorkload) {
  console.error(
    `Error: Default workload '${DEFAULT_WORKLOAD_ID}' not found in ${config.workloadsDir}`,
  )
  console.error('Please create a config/workloads/default.yaml file')
  process.exit(1)
}
console.log(`  - Default workload: ${defaultWorkload.name} (${defaultWorkload.image})`)

// Initialize container runtime
const runtime = new DockerRuntime()
console.log(`  - Runtime: ${runtime.name}`)

// Initialize container manager
const manager = new ContainerManager(runtime)

// Initialize container pool with default workload
const pool = new ContainerPool(manager, {
  workload: defaultWorkload,
  poolId: DEFAULT_POOL_ID,
})

// Watch for workload file changes in development
if (process.env.NODE_ENV !== 'production') {
  workloadRegistry.startWatching()
  workloadRegistry.onChange((event) => {
    switch (event.type) {
      case 'added':
        console.log(`Workload added: ${event.workload.id}`)
        break
      case 'updated':
        console.log(`Workload updated: ${event.workload.id}`)
        break
      case 'removed':
        console.log(`Workload removed: ${event.workloadId}`)
        break
    }
  })
  console.log('Watching for workload file changes...')
}

console.log('Boilerhouse API server initialized')

// TODO: Initialize state sync
// TODO: Initialize router
// TODO: Start HTTP API server with Elysia

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...')
  workloadRegistry.stopWatching()
  await pool.drain()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  workloadRegistry.stopWatching()
  await pool.drain()
  process.exit(0)
})
