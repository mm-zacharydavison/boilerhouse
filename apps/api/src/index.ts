import {
  ActivityRepository,
  AffinityRepository,
  ClaimRepository,
  PoolRepository,
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
const claimRepo = new ClaimRepository(db)
const affinityRepo = new AffinityRepository(db)
const syncStatusRepo = new SyncStatusRepository(db)
const activityRepo = new ActivityRepository(db)
const poolRepo = new PoolRepository(db)

// Initialize container runtime
const runtime = new DockerRuntime()
console.log(`  - Runtime: ${runtime.name}`)

// Run recovery/reconciliation (Docker = truth for existence, DB = truth for domain state)
const recoveryStats = await recoverState(runtime, claimRepo, affinityRepo, {
  labelPrefix: 'boilerhouse',
})
console.log(
  `  - Recovery: docker=${recoveryStats.dockerContainers}, staleClaims=${recoveryStats.staleClaims}, ` +
    `staleAffinity=${recoveryStats.staleAffinity}, expiredAffinity=${recoveryStats.expiredAffinity}`,
)

// Load workloads from YAML files
const workloadRegistry = createWorkloadRegistry(config.workloadsDir)
console.log(
  `  - Loaded ${workloadRegistry.size} workload(s): ${workloadRegistry.ids().join(', ') || '(none)'}`,
)

// Initialize activity log with persistence
const activityLog = new ActivityLog(activityRepo)

// Initialize container manager with claim persistence
const manager = new ContainerManager(runtime, undefined, claimRepo)

// Initialize pool registry with all repos
const poolRegistry = new PoolRegistry(
  manager,
  workloadRegistry,
  activityLog,
  claimRepo,
  affinityRepo,
  poolRepo,
)

// Restore pools from DB
const restoredPools = poolRegistry.restoreFromDb()
if (restoredPools > 0) {
  console.log(`  - Restored ${restoredPools} pool(s) from database`)
}

// Restore affinity reservations for each pool
const activeAffinityReservations = affinityRepo.findActive()
for (const reservation of activeAffinityReservations) {
  const pool = poolRegistry.getPool(reservation.poolId)
  if (pool) {
    const remainingMs = reservation.expiresAt.getTime() - Date.now()
    // Build a PoolContainer from computed paths
    const container = {
      containerId: reservation.containerId,
      tenantId: null,
      poolId: reservation.poolId,
      socketPath: manager.getSocketPath(reservation.containerId),
      stateDir: manager.getStateDir(reservation.containerId),
      secretsDir: manager.getSecretsDir(reservation.containerId),
      lastActivity: reservation.createdAt,
      status: 'idle' as const,
    }
    pool.restoreAffinityTimeout(reservation.tenantId, container, remainingMs)
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
