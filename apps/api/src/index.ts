import { mkdirSync } from 'node:fs'
import { closeDatabase, initDatabase } from '@boilerhouse/db'
import { DockerRuntime, type DockerRuntimeConfig } from '@boilerhouse/docker'
import { config } from '../lib/config'
import { createLogger } from '../lib/logger'
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

const log = createLogger()

log.info(
  {
    minIdle: config.pool.minPoolIdle,
    maxContainers: config.pool.maxContainersPerNode,
    api: `${config.apiHost}:${config.apiPort}`,
    workloadsDir: config.workloadsDir,
    dbPath: config.dbPath,
  },
  'Starting Boilerhouse API server',
)

// Ensure base directories exist before any container operations
for (const dir of [config.stateBaseDir, config.secretsBaseDir, config.socketBaseDir]) {
  mkdirSync(dir, { recursive: true })
}

// Initialize SQLite database with WAL mode
const db = initDatabase({ path: config.dbPath })

// Initialize container runtime with optional DOCKER_HOST configuration
const dockerConfig = parseDockerHost(process.env.DOCKER_HOST)
const runtime = new DockerRuntime(dockerConfig)

// Log Docker connection target
const dockerTarget = dockerConfig?.host
  ? `tcp://${dockerConfig.host}:${dockerConfig.port ?? 2375}`
  : (dockerConfig?.socketPath ?? '/var/run/docker.sock')
log.info({ runtime: runtime.name, target: dockerTarget }, 'Container runtime configured')

// Wire all services
const app = new App({
  runtime,
  db,
  workloadsDir: config.workloadsDir,
  logger: log,
})

log.info(
  { count: app.workloadRegistry.size, workloads: app.workloadRegistry.ids() },
  'Workloads loaded',
)

// Run recovery, restore pools and idle reaper watches
const { recoveryStats } = await app.start()
if (recoveryStats) {
  log.info(
    {
      dockerContainers: recoveryStats.dockerContainers,
      staleContainers: recoveryStats.staleContainers,
    },
    'Recovery complete',
  )
}

const restoredPools = app.poolRegistry.getPools().size
if (restoredPools > 0) {
  log.info({ count: restoredPools }, 'Pools restored from database')
}

app.server.listen({
  hostname: config.apiHost,
  port: config.apiPort,
})

log.info({ host: config.apiHost, port: config.apiPort }, 'Boilerhouse API server listening')

// Watch for workload file changes in development
if (process.env.NODE_ENV !== 'production') {
  app.workloadRegistry.startWatching()
  app.workloadRegistry.onChange((event) => {
    switch (event.type) {
      case 'added':
        log.info({ workloadId: event.workload.id }, 'Workload added')
        break
      case 'updated':
        log.info({ workloadId: event.workload.id }, 'Workload updated')
        break
      case 'removed':
        log.info({ workloadId: event.workloadId }, 'Workload removed')
        break
    }
  })
  log.info('Watching for workload file changes')
}

// Graceful shutdown - preserves containers for recovery on restart
async function shutdown() {
  log.info('Shutting down...')
  await app.shutdown()
  closeDatabase(db)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
