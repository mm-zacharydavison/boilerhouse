import { DockerRuntime } from '@boilerhouse/docker'
import { getActivityLog } from '../lib/activity'
import { config } from '../lib/config'
import { ContainerManager } from '../lib/container'
import { PoolRegistry } from '../lib/pool/registry'
import { RcloneSyncExecutor, SyncCoordinator, SyncStatusTracker } from '../lib/sync'
import { createWorkloadRegistry } from '../lib/workload'
import { createServer } from './server'

console.log('Starting Boilerhouse API server...')
console.log('Configuration:')
console.log(`  - Pool size: ${config.pool.minPoolSize}`)
console.log(`  - Max containers: ${config.pool.maxContainersPerNode}`)
console.log(`  - API: ${config.apiHost}:${config.apiPort}`)
console.log(`  - Workloads dir: ${config.workloadsDir}`)

// Load workloads from YAML files
const workloadRegistry = createWorkloadRegistry(config.workloadsDir)
console.log(
  `  - Loaded ${workloadRegistry.size} workload(s): ${workloadRegistry.ids().join(', ') || '(none)'}`,
)

// Initialize container runtime
const runtime = new DockerRuntime()
console.log(`  - Runtime: ${runtime.name}`)

// Initialize activity log
const activityLog = getActivityLog()

// Initialize container manager
const manager = new ContainerManager(runtime)

// Initialize pool registry
const poolRegistry = new PoolRegistry(manager, workloadRegistry, activityLog)

// Initialize sync components
const syncStatusTracker = new SyncStatusTracker()
const rcloneExecutor = new RcloneSyncExecutor({ verbose: true })
const syncCoordinator = new SyncCoordinator(rcloneExecutor, syncStatusTracker, { verbose: true })

// Create and start Elysia server
const server = createServer({
  poolRegistry,
  workloadRegistry,
  containerManager: manager,
  syncCoordinator,
  syncStatusTracker,
  activityLog,
})

server.listen({
  hostname: config.apiHost,
  port: config.apiPort,
})

console.log(`Boilerhouse API server listening on ${config.apiHost}:${config.apiPort}`)

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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...')
  workloadRegistry.stopWatching()
  await syncCoordinator.shutdown()
  await poolRegistry.shutdown()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  workloadRegistry.stopWatching()
  await syncCoordinator.shutdown()
  await poolRegistry.shutdown()
  process.exit(0)
})
