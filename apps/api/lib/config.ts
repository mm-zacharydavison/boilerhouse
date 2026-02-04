import type { BoilerhouseConfig } from '@boilerhouse/core'

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key]
  if (value === undefined) return defaultValue
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? defaultValue : parsed
}

function getEnvString(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue
}

export const config: BoilerhouseConfig = {
  pool: {
    minPoolSize: getEnvNumber('BOILERHOUSE_POOL_SIZE', 5),
    maxContainersPerNode: getEnvNumber('BOILERHOUSE_MAX_CONTAINERS', 50),
    containerIdleTimeoutMs: getEnvNumber('BOILERHOUSE_IDLE_TIMEOUT_MS', 5 * 60 * 1000),
    containerStartTimeoutMs: getEnvNumber('BOILERHOUSE_START_TIMEOUT_MS', 30 * 1000),
  },

  resources: {
    cpus: getEnvNumber('BOILERHOUSE_CONTAINER_CPUS', 1),
    memoryMb: getEnvNumber('BOILERHOUSE_CONTAINER_MEMORY_MB', 512),
    tmpfsSizeMb: getEnvNumber('BOILERHOUSE_CONTAINER_TMPFS_MB', 100),
  },

  stateBaseDir: getEnvString('BOILERHOUSE_STATE_DIR', '/var/lib/boilerhouse/states'),
  secretsBaseDir: getEnvString('BOILERHOUSE_SECRETS_DIR', '/var/lib/boilerhouse/secrets'),
  socketBaseDir: getEnvString('BOILERHOUSE_SOCKET_DIR', '/var/run/boilerhouse'),

  apiPort: getEnvNumber('BOILERHOUSE_API_PORT', 3000),
  apiHost: getEnvString('BOILERHOUSE_API_HOST', '0.0.0.0'),
}
