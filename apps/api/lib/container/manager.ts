/**
 * Container Manager
 *
 * Manages the lifecycle of isolated containers in the pool.
 * Uses the ContainerRuntime interface to support multiple backends (Docker, Kubernetes).
 *
 * Container existence is tracked by Docker (source of truth).
 * Container state (claims, affinity) is managed by ContainerPool via the DB.
 * Paths are computed deterministically from containerId.
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ContainerId,
  type ContainerRuntime,
  type ContainerSpec,
  DEFAULT_SECURITY_CONFIG,
  type DefaultResourceLimits,
  type HealthCheckSpec,
  type PoolContainer,
  type PoolId,
  type WorkloadSpec,
} from '@boilerhouse/core'
import { config } from '../config'

export interface ContainerManagerConfig {
  /** Base directory for tenant state (host path) */
  stateBaseDir: string

  /** Base directory for tenant secrets (host path) */
  secretsBaseDir: string

  /** Base directory for Unix sockets (host path) */
  socketBaseDir: string

  /** Default Docker networks for containers (can be overridden by workload/pool) */
  networks: string[]

  /** Default resource limits per container (can be overridden by workload) */
  resources: DefaultResourceLimits

  /** Label prefix for tracking containers */
  labelPrefix: string
}

const DEFAULT_CONFIG: ContainerManagerConfig = {
  stateBaseDir: config.stateBaseDir,
  secretsBaseDir: config.secretsBaseDir,
  socketBaseDir: config.socketBaseDir,
  networks: ['bridge'], // Docker's default network
  resources: config.resources,
  labelPrefix: 'boilerhouse',
}

export class ContainerManager {
  private runtime: ContainerRuntime
  private config: ContainerManagerConfig

  constructor(
    runtime: ContainerRuntime,
    managerConfig: Partial<ContainerManagerConfig> | undefined,
  ) {
    this.runtime = runtime
    this.config = { ...DEFAULT_CONFIG, ...managerConfig }
  }

  /**
   * Get the runtime being used
   */
  getRuntime(): ContainerRuntime {
    return this.runtime
  }

  /**
   * Compute the state directory path for a container.
   */
  getStateDir(containerId: string): string {
    return join(this.config.stateBaseDir, containerId)
  }

  /**
   * Compute the secrets directory path for a container.
   */
  getSecretsDir(containerId: string): string {
    return join(this.config.secretsBaseDir, containerId)
  }

  /**
   * Compute the socket path for a container.
   */
  getSocketPath(containerId: string): string {
    return join(this.config.socketBaseDir, containerId, 'app.sock')
  }

  /**
   * Create a new container (unclaimed, for pool)
   *
   * @param workload - Workload specification defining image, volumes, env, etc.
   * @param poolId - ID of the pool this container belongs to
   * @param networks - Optional network names override (defaults to workload config or manager config)
   */
  async createContainer(
    workload: WorkloadSpec,
    poolId: PoolId,
    networks?: string[],
  ): Promise<PoolContainer> {
    const containerId = this.generateContainerId()
    const containerName = `container-${containerId}`
    const stateDir = this.getStateDir(containerId)
    const secretsDir = this.getSecretsDir(containerId)
    const socketDir = join(this.config.socketBaseDir, containerId)
    const socketPath = this.getSocketPath(containerId)

    // Create host directories
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(secretsDir, { recursive: true }),
      mkdir(socketDir, { recursive: true }),
    ])

    // Build volume mounts from workload spec
    const volumes: ContainerSpec['volumes'] = []

    if (workload.volumes.state) {
      volumes.push({
        source: stateDir,
        target: workload.volumes.state.target,
        readOnly: workload.volumes.state.readOnly ?? false,
      })
    }

    if (workload.volumes.secrets) {
      volumes.push({
        source: secretsDir,
        target: workload.volumes.secrets.target,
        readOnly: workload.volumes.secrets.readOnly ?? true,
      })
    }

    if (workload.volumes.comm) {
      volumes.push({
        source: socketDir,
        target: workload.volumes.comm.target,
        readOnly: workload.volumes.comm.readOnly ?? false,
      })
    }

    // Add custom volumes
    if (workload.volumes.custom) {
      for (const custom of workload.volumes.custom) {
        const customDir = join(this.config.stateBaseDir, containerId, 'custom', custom.name)
        await mkdir(customDir, { recursive: true })
        volumes.push({
          source: customDir,
          target: custom.target,
          readOnly: custom.readOnly ?? false,
        })
      }
    }

    // Build environment variables from workload spec
    const env: ContainerSpec['env'] = Object.entries(workload.environment).map(([name, value]) => ({
      name,
      value,
    }))

    // Merge resource limits (workload deploy.resources.limits overrides manager defaults)
    const workloadLimits = workload.deploy?.resources?.limits
    const cpusValue = workloadLimits?.cpus ?? this.config.resources.cpus
    const memoryValue = workloadLimits?.memory ?? this.config.resources.memory
    const resources = {
      cpus: typeof cpusValue === 'string' ? Number.parseFloat(cpusValue) : cpusValue,
      memory: typeof memoryValue === 'string' ? Number.parseInt(memoryValue, 10) : memoryValue,
      tmpfsSize: this.config.resources.tmpfsSize,
    }

    // Build security config (workload overrides defaults)
    const security = {
      ...DEFAULT_SECURITY_CONFIG,
      readOnlyRootFilesystem: workload.readOnly ?? true,
      runAsUser:
        typeof workload.user === 'number'
          ? workload.user
          : (DEFAULT_SECURITY_CONFIG.runAsUser ?? undefined),
    }

    // Build health check from workload spec
    const healthCheck: HealthCheckSpec | undefined = workload.healthcheck
      ? {
          command: workload.healthcheck.test,
          intervalMs: workload.healthcheck.interval,
          timeoutMs: workload.healthcheck.timeout,
          retries: workload.healthcheck.retries,
          startPeriodMs: workload.healthcheck.startPeriod,
        }
      : undefined

    // Create container spec
    const tmpfsSizeBytes = (resources.tmpfsSize ?? 100) * 1024 * 1024
    const spec: ContainerSpec = {
      name: containerName,
      image: workload.image,
      command: workload.command,
      env,
      volumes,
      tmpfs: [
        {
          target: '/tmp',
          sizeBytes: tmpfsSizeBytes,
          mode: 0o1777,
        },
        {
          target: '/var/tmp',
          sizeBytes: tmpfsSizeBytes,
          mode: 0o1777,
        },
        { target: '/run', sizeBytes: 10 * 1024 * 1024, mode: 0o755 },
      ],
      resources,
      security,
      network: {
        networks: networks ?? workload.networks ?? this.config.networks,
        dnsServers: workload.dns ?? ['8.8.8.8', '1.1.1.1'],
      },
      labels: {
        [`${this.config.labelPrefix}.managed`]: 'true',
        [`${this.config.labelPrefix}.container-id`]: containerId,
        [`${this.config.labelPrefix}.pool-id`]: poolId,
        [`${this.config.labelPrefix}.workload-id`]: workload.id,
        [`${this.config.labelPrefix}.created-at`]: new Date().toISOString(),
      },
      healthCheck,
    }

    // Create and start container via runtime
    await this.runtime.createContainer(spec)

    const poolContainer: PoolContainer = {
      containerId,
      tenantId: null,
      poolId,
      socketPath,
      stateDir,
      secretsDir,
      lastActivity: new Date(),
      status: 'idle',
    }

    return poolContainer
  }

  /**
   * Wipe container state for a new tenant.
   * Wipes state, secrets, and bisync cache for tenant isolation.
   */
  async wipeForNewTenant(containerId: ContainerId): Promise<void> {
    const stateDir = this.getStateDir(containerId)
    const secretsDir = this.getSecretsDir(containerId)

    await Promise.all([
      this.wipeDirectory(stateDir),
      this.wipeDirectory(secretsDir),
      this.wipeBisyncCache(stateDir),
    ])
  }

  /**
   * Restart a container to get a fresh process.
   * Call this after sync to ensure the new tenant gets a clean process with their data.
   */
  async restartContainer(containerId: ContainerId, timeoutSeconds = 10): Promise<void> {
    const containerName = `container-${containerId}`
    await this.runtime.restartContainer(containerName, timeoutSeconds)
  }

  /**
   * Stop and remove a container completely (runtime + host dirs only).
   * Does not touch the DB — the pool handles DB cleanup.
   */
  async destroyContainer(containerId: ContainerId): Promise<void> {
    const containerName = `container-${containerId}`
    await this.runtime.destroyContainer(containerName, 10)

    // Clean up host directories
    await Promise.all([
      rm(this.getStateDir(containerId), { recursive: true, force: true }),
      rm(this.getSecretsDir(containerId), { recursive: true, force: true }),
      rm(join(this.config.socketBaseDir, containerId), { recursive: true, force: true }),
    ])
  }

  /**
   * Check container health via runtime
   */
  async isHealthy(containerId: ContainerId): Promise<boolean> {
    const containerName = `container-${containerId}`
    return this.runtime.isHealthy(containerName)
  }

  /**
   * Get the label prefix used for container tracking.
   */
  getLabelPrefix(): string {
    return this.config.labelPrefix
  }

  private generateContainerId(): ContainerId {
    return ContainerId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
  }

  private async wipeDirectory(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
    } catch {
      // Directory might not exist, that's fine
      await mkdir(dir, { recursive: true })
    }
  }

  /**
   * Wipe rclone bisync cache files for a container.
   * Bisync stores tracking files in ~/.cache/rclone/bisync/ with paths encoded in filenames.
   */
  private async wipeBisyncCache(stateDir: string): Promise<void> {
    const bisyncCacheDir = join(homedir(), '.cache', 'rclone', 'bisync')

    try {
      const files = await readdir(bisyncCacheDir)
      // Convert stateDir path to the format used in bisync filenames (slashes become underscores)
      const stateDirPattern = stateDir.replace(/\//g, '_')

      const deletions = files
        .filter((file) => file.includes(stateDirPattern))
        .map((file) => rm(join(bisyncCacheDir, file), { force: true }))

      await Promise.all(deletions)
    } catch {
      // Cache directory might not exist, that's fine
    }
  }
}
