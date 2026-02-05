import {
  ActivityRepository,
  AffinityRepository,
  ContainerRepository,
  SyncStatusRepository,
  closeDatabase,
  initDatabase,
} from '@boilerhouse/db'
import { DockerRuntime } from '@boilerhouse/docker'
import { ActivityLog } from '../lib/activity'
import { config } from '../lib/config'
import { ContainerManager } from '../lib/container'
import { PoolRegistry } from '../lib/pool/registry'
import { recoverState } from '../lib/recovery'
import { RcloneSyncExecutor, SyncCoordinator, SyncStatusTracker } from '../lib/sync'
import { createWorkloadRegistry } from '../lib/workload'
import { createServer } from './server'

console.log('Starting Boilerhouse API server...')
console.log('Configuration:')
console.log(`  - Pool size: ${config.pool.minPoolSize}`)
console.log(`  - Max containers: ${config.pool.maxContainersPerNode}`)
console.log(`  - API: ${config.apiHost}:${config.apiPort}`)
console.log(`  - Workloads dir: ${config.workloadsDir}`)
console.log(`  - Database: ${config.dbPath}`)

// Initialize SQLite database with WAL mode
const db = initDatabase({ path: config.dbPath })

// Create repositories
const containerRepo = new ContainerRepository(db)
const affinityRepo = new AffinityRepository(db)
const syncStatusRepo = new SyncStatusRepository(db)
const activityRepo = new ActivityRepository(db)

// Initialize container runtime
const runtime = new DockerRuntime()
console.log(`  - Runtime: ${runtime.name}`)

// Run recovery/reconciliation (DB vs Docker)
const recoveryStats = await recoverState(runtime, containerRepo, affinityRepo, {
  labelPrefix: 'boilerhouse',
})
console.log(
  `  - Recovery: restored=${recoveryStats.restored}, orphaned=${recoveryStats.orphaned}, ` +
    `stopped=${recoveryStats.stopped}, foreign=${recoveryStats.foreign}`,
)

// Load workloads from YAML files
const workloadRegistry = createWorkloadRegistry(config.workloadsDir)
console.log(
  `  - Loaded ${workloadRegistry.size} workload(s): ${workloadRegistry.ids().join(', ') || '(none)'}`,
)

// Initialize activity log with persistence
const activityLog = new ActivityLog(undefined, activityRepo)

// Initialize container manager with persistence
const manager = new ContainerManager(runtime, undefined, containerRepo)

// Restore container state from database
const restoredContainers = manager.restoreFromRepository()
console.log(`  - Restored ${restoredContainers.length} containers from database`)

// Initialize pool registry with affinity persistence
const poolRegistry = new PoolRegistry(manager, workloadRegistry, activityLog, affinityRepo)

// Restore affinity reservations for each pool
const activeAffinityReservations = affinityRepo.findActive()
for (const reservation of activeAffinityReservations) {
  const container = manager.getContainer(reservation.containerId)
  if (container) {
    const pool = poolRegistry.getPool(reservation.poolId)
    if (pool) {
      const remainingMs = reservation.expiresAt.getTime() - Date.now()
      pool.restoreAffinity(reservation.tenantId, container, remainingMs)
    }
  }
}
if (activeAffinityReservations.length > 0) {
  console.log(`  - Restored ${activeAffinityReservations.length} affinity reservations`)
}

// Initialize sync components with persistence
const syncStatusTracker = new SyncStatusTracker(syncStatusRepo)
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

// Graceful shutdown - preserves containers for recovery on restart
async function shutdown() {
  console.log('Shutting down...')
  workloadRegistry.stopWatching()
  await syncCoordinator.shutdown()
  poolRegistry.shutdown()
  closeDatabase(db)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
