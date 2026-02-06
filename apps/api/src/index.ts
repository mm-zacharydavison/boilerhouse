import { closeDatabase, initDatabase } from '@boilerhouse/db'
import { DockerRuntime, type DockerRuntimeConfig } from '@boilerhouse/docker'
import { config } from '../lib/config'
import { App } from './app'

/**
 * Parse DOCKER_HOST environment variable into DockerRuntimeConfig.
 *
 * Supports:
 * - tcp://host:port → { host, port }
 * - unix:///path → { socketPath }
 * - unset → undefined (uses default /var/run/docker.sock)
 */
function parseDockerHost(dockerHost: string | undefined): DockerRuntimeConfig | undefined {
  if (!dockerHost) {
    return undefined
  }

  if (dockerHost.startsWith('tcp://')) {
    const url = new URL(dockerHost)
    return {
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : 2375,
    }
  }

  if (dockerHost.startsWith('unix://')) {
    return {
      socketPath: dockerHost.slice('unix://'.length),
    }
  }

  // Treat as socket path if it starts with /
  if (dockerHost.startsWith('/')) {
    return { socketPath: dockerHost }
  }

  throw new Error(
    `Invalid DOCKER_HOST: ${dockerHost}. Expected tcp://host:port, unix:///path, or /path`,
  )
}

console.log('Starting Boilerhouse API server...')
console.log('Configuration:')
console.log(`  - Min idle: ${config.pool.minPoolIdle}`)
console.log(`  - Max containers: ${config.pool.maxContainersPerNode}`)
console.log(`  - API: ${config.apiHost}:${config.apiPort}`)
console.log(`  - Workloads dir: ${config.workloadsDir}`)
console.log(`  - Database: ${config.dbPath}`)

// Initialize SQLite database with WAL mode
const db = initDatabase({ path: config.dbPath })

// Initialize container runtime with optional DOCKER_HOST configuration
const dockerConfig = parseDockerHost(process.env.DOCKER_HOST)
const runtime = new DockerRuntime(dockerConfig)

// Log Docker connection target
const dockerTarget = dockerConfig?.host
  ? `tcp://${dockerConfig.host}:${dockerConfig.port ?? 2375}`
  : (dockerConfig?.socketPath ?? '/var/run/docker.sock')
console.log(`  - Runtime: ${runtime.name} (${dockerTarget})`)

// Wire all services
const app = new App({
  runtime,
  db,
  workloadsDir: config.workloadsDir,
})

console.log(
  `  - Loaded ${app.workloadRegistry.size} workload(s): ${app.workloadRegistry.ids().join(', ') || '(none)'}`,
)

// Run recovery, restore pools and idle reaper watches
const { recoveryStats } = await app.start()
if (recoveryStats) {
  console.log(
    `  - Recovery: docker=${recoveryStats.dockerContainers}, staleContainers=${recoveryStats.staleContainers}`,
  )
}

const restoredPools = app.poolRegistry.getPools().size
if (restoredPools > 0) {
  console.log(`  - Restored ${restoredPools} pool(s) from database`)
}

app.server.listen({
  hostname: config.apiHost,
  port: config.apiPort,
})

console.log(`Boilerhouse API server listening on ${config.apiHost}:${config.apiPort}`)

// Watch for workload file changes in development
if (process.env.NODE_ENV !== 'production') {
  app.workloadRegistry.startWatching()
  app.workloadRegistry.onChange((event) => {
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
  await app.shutdown()
  closeDatabase(db)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
