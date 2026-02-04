import type { PoolId, WorkloadId, WorkloadSpec } from '@boilerhouse/core'
import { DockerRuntime } from '@boilerhouse/docker'
import { config } from '../lib/config'
import { ContainerManager, ContainerPool } from '../lib/container'

// Example default workload spec - in production, this would come from a registry
const DEFAULT_WORKLOAD: WorkloadSpec = {
  id: 'default' as WorkloadId,
  name: 'Default Workload',
  image: process.env.BOILERHOUSE_DEFAULT_IMAGE ?? 'alpine:latest',
  volumes: {
    state: { containerPath: '/state', mode: 'rw' },
    secrets: { containerPath: '/secrets', mode: 'ro' },
    comm: { containerPath: '/comm', mode: 'rw' },
  },
  environment: {
    STATE_DIR: '/state',
    SECRETS_DIR: '/secrets',
    SOCKET_PATH: '/comm/app.sock',
  },
  healthCheck: {
    command: ['true'], // Simple health check for alpine
    intervalMs: 30000,
    timeoutMs: 5000,
    retries: 3,
  },
}

const DEFAULT_POOL_ID = 'default-pool' as PoolId

console.log('Starting Boilerhouse API server...')
console.log('Configuration:')
console.log(`  - Pool size: ${config.pool.minPoolSize}`)
console.log(`  - Max containers: ${config.pool.maxContainersPerNode}`)
console.log(`  - API: ${config.apiHost}:${config.apiPort}`)
console.log(`  - Default workload: ${DEFAULT_WORKLOAD.name} (${DEFAULT_WORKLOAD.image})`)

// Initialize container runtime
const runtime = new DockerRuntime()
console.log(`  - Runtime: ${runtime.name}`)

// Initialize container manager
const manager = new ContainerManager(runtime)

// Initialize container pool with default workload
const pool = new ContainerPool(manager, {
  workload: DEFAULT_WORKLOAD,
  poolId: DEFAULT_POOL_ID,
})

console.log('Boilerhouse API server initialized')

// TODO: Initialize state sync
// TODO: Initialize router
// TODO: Start HTTP API server with Elysia

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...')
  await pool.drain()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  await pool.drain()
  process.exit(0)
})
