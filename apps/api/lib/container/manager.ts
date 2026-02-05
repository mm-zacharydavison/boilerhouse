/**
 * Container Manager
 *
 * Manages the lifecycle of isolated containers in the pool.
 * Uses the ContainerRuntime interface to support multiple backends (Docker, Kubernetes).
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type ContainerId,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
  DEFAULT_SECURITY_CONFIG,
  type DefaultResourceLimits,
  type HealthCheckSpec,
  type PoolContainer,
  type PoolId,
  type TenantId,
  type WorkloadSpec,
} from '@boilerhouse/core'
import type { ContainerRepository } from '@boilerhouse/db'
import { config } from '../config'

export interface ContainerManagerConfig {
  /** Base directory for tenant state (host path) */
  stateBaseDir: string

  /** Base directory for tenant secrets (host path) */
  secretsBaseDir: string

  /** Base directory for Unix sockets (host path) */
  socketBaseDir: string

  /** Default network name for container isolation (can be overridden by workload) */
  networkName: string

  /** Default resource limits per container (can be overridden by workload) */
  resources: DefaultResourceLimits

  /** Label prefix for tracking containers */
  labelPrefix: string
}

const DEFAULT_CONFIG: ContainerManagerConfig = {
  stateBaseDir: config.stateBaseDir,
  secretsBaseDir: config.secretsBaseDir,
  socketBaseDir: config.socketBaseDir,
  networkName: 'bridge', // Docker's default network
  resources: config.resources,
  labelPrefix: 'boilerhouse',
}

export class ContainerManager {
  private runtime: ContainerRuntime
  private config: ContainerManagerConfig
  private containers: Map<ContainerId, PoolContainer> = new Map()
  private containerRepo?: ContainerRepository

  constructor(
    runtime: ContainerRuntime,
    managerConfig?: Partial<ContainerManagerConfig>,
    containerRepo?: ContainerRepository,
  ) {
    this.runtime = runtime
    this.config = { ...DEFAULT_CONFIG, ...managerConfig }
    this.containerRepo = containerRepo
  }

  /**
   * Get the runtime being used
   */
  getRuntime(): ContainerRuntime {
    return this.runtime
  }

  /**
   * Create a new container (unassigned, for pool)
   *
   * @param workload - Workload specification defining image, volumes, env, etc.
   * @param poolId - ID of the pool this container belongs to
   * @param networkName - Optional network name override (defaults to pool config or manager config)
   */
  async createContainer(
    workload: WorkloadSpec,
    poolId: PoolId,
    networkName?: string,
  ): Promise<PoolContainer> {
    const containerId = this.generateContainerId()
    const containerName = `container-${containerId}`
    const stateDir = join(this.config.stateBaseDir, containerId)
    const secretsDir = join(this.config.secretsBaseDir, containerId)
    const socketDir = join(this.config.socketBaseDir, containerId)
    const socketPath = join(socketDir, 'app.sock')

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
        network: networkName ?? this.config.networkName,
        dnsServers: ['8.8.8.8', '1.1.1.1'],
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

    this.containers.set(containerId, poolContainer)
    this.containerRepo?.save(poolContainer)
    return poolContainer
  }

  /**
   * Assign a container to a tenant
   */
  async assignToTenant(
    containerId: ContainerId,
    tenantId: TenantId,
    envVars?: Record<string, string>,
  ): Promise<PoolContainer> {
    const container = this.containers.get(containerId)
    if (!container) {
      throw new Error(`Container ${containerId} not found`)
    }

    if (container.tenantId !== null) {
      throw new Error(`Container ${containerId} already assigned to tenant ${container.tenantId}`)
    }

    // If we need to inject environment variables (LLM API keys), we need to
    // stop and recreate the container with new env vars, or use a different approach.
    // For now, we'll write credentials to the secrets directory instead.
    if (envVars && Object.keys(envVars).length > 0) {
      // Environment variables are passed via secrets files, not container env
      // This avoids needing to recreate the container
      console.warn('Environment variables should be passed via secrets files, not container env')
    }

    container.tenantId = tenantId
    container.status = 'assigned'
    container.lastActivity = new Date()

    this.containerRepo?.updateTenant(containerId, tenantId, 'assigned')
    return container
  }

  /**
   * Release a container from a tenant.
   * Does NOT wipe state - that happens on claim if the next tenant is different.
   * This allows returning tenants to get their previous container with state intact.
   */
  async releaseContainer(containerId: ContainerId): Promise<void> {
    const container = this.containers.get(containerId)
    if (!container) {
      throw new Error(`Container ${containerId} not found`)
    }

    // Preserve lastTenantId for affinity matching on next claim
    container.lastTenantId = container.tenantId
    container.tenantId = null
    container.status = 'idle'
    container.lastActivity = new Date()

    this.containerRepo?.updateTenant(containerId, null, 'idle')
    this.containerRepo?.updateLastTenantId(containerId, container.lastTenantId)
  }

  /**
   * Wipe container state for a new tenant.
   * Called when a container is claimed by a different tenant than its lastTenantId.
   * Wipes state, secrets, and bisync cache for tenant isolation.
   */
  async wipeForNewTenant(containerId: ContainerId): Promise<void> {
    const container = this.containers.get(containerId)
    if (!container) {
      throw new Error(`Container ${containerId} not found`)
    }

    await Promise.all([
      this.wipeDirectory(container.stateDir),
      this.wipeDirectory(container.secretsDir),
      this.wipeBisyncCache(container.stateDir),
    ])

    // Clear lastTenantId since we've wiped the state
    container.lastTenantId = null
    this.containerRepo?.updateLastTenantId(containerId, null)
  }

  /**
   * Restart a container to get a fresh process.
   * Call this after sync to ensure the new tenant gets a clean process with their data.
   */
  async restartContainer(containerId: ContainerId, timeoutSeconds = 10): Promise<void> {
    const container = this.containers.get(containerId)
    if (!container) {
      throw new Error(`Container ${containerId} not found`)
    }

    const containerName = `container-${containerId}`
    await this.runtime.restartContainer(containerName, timeoutSeconds)
    container.lastActivity = new Date()
  }

  /**
   * Stop and remove a container completely
   */
  async destroyContainer(containerId: ContainerId): Promise<void> {
    const container = this.containers.get(containerId)
    if (!container) {
      throw new Error(`Container ${containerId} not found`)
    }

    container.status = 'stopping'

    // Destroy via runtime
    const containerName = `container-${containerId}`
    await this.runtime.destroyContainer(containerName, 10)

    // Clean up host directories
    await Promise.all([
      rm(container.stateDir, { recursive: true, force: true }),
      rm(container.secretsDir, { recursive: true, force: true }),
      rm(join(this.config.socketBaseDir, containerId), { recursive: true, force: true }),
    ])

    this.containers.delete(containerId)
    this.containerRepo?.delete(containerId)
  }

  /**
   * Get container by ID
   */
  getContainer(containerId: ContainerId): PoolContainer | undefined {
    return this.containers.get(containerId)
  }

  /**
   * Get container by tenant ID
   */
  getContainerByTenant(tenantId: TenantId): PoolContainer | undefined {
    for (const container of this.containers.values()) {
      if (container.tenantId === tenantId) {
        return container
      }
    }
    return undefined
  }

  /**
   * Get all containers
   */
  getAllContainers(): PoolContainer[] {
    return Array.from(this.containers.values())
  }

  /**
   * Get containers by status
   */
  getContainersByStatus(status: ContainerStatus): PoolContainer[] {
    return Array.from(this.containers.values()).filter((c) => c.status === status)
  }

  /**
   * Update last activity timestamp
   */
  recordActivity(containerId: ContainerId): void {
    const container = this.containers.get(containerId)
    if (container) {
      container.lastActivity = new Date()
    }
  }

  /**
   * Check container health via runtime
   */
  async isHealthy(containerId: ContainerId): Promise<boolean> {
    const containerName = `container-${containerId}`
    return this.runtime.isHealthy(containerName)
  }

  /**
   * Get idle containers that have exceeded the timeout
   */
  getStaleContainers(maxIdleMs: number): PoolContainer[] {
    const now = Date.now()
    return Array.from(this.containers.values()).filter((c) => {
      if (c.status !== 'assigned') return false
      return now - c.lastActivity.getTime() > maxIdleMs
    })
  }

  /**
   * Restore container state from the repository (for recovery after restart).
   * Only restores containers that still exist in Docker.
   */
  restoreFromRepository(): PoolContainer[] {
    if (!this.containerRepo) {
      return []
    }

    const containers = this.containerRepo.findAll()
    for (const container of containers) {
      this.containers.set(container.containerId, container)
    }
    return containers
  }

  /**
   * Get the container repository (for recovery operations).
   */
  getContainerRepository(): ContainerRepository | undefined {
    return this.containerRepo
  }

  /**
   * Remove a container from in-memory tracking only (used during recovery).
   */
  removeFromMemory(containerId: ContainerId): void {
    this.containers.delete(containerId)
  }

  /**
   * Sync container state from runtime (for recovery after restart)
   */
  async syncFromRuntime(): Promise<void> {
    const containers = await this.runtime.listContainers({
      [`${this.config.labelPrefix}.managed`]: 'true',
    })

    for (const info of containers) {
      const containerId = info.labels[`${this.config.labelPrefix}.container-id`]
      if (!containerId) continue

      // Only track running containers
      if (info.status !== 'running') {
        // Clean up stopped containers
        await this.runtime.removeContainer(info.id)
        continue
      }

      // Reconstruct container state
      const container: PoolContainer = {
        containerId,
        tenantId: info.labels[`${this.config.labelPrefix}.tenant-id`] ?? null,
        poolId: info.labels[`${this.config.labelPrefix}.pool-id`] ?? '',
        socketPath: join(this.config.socketBaseDir, containerId, 'app.sock'),
        stateDir: join(this.config.stateBaseDir, containerId),
        secretsDir: join(this.config.secretsBaseDir, containerId),
        lastActivity: info.startedAt ?? new Date(),
        status: info.labels[`${this.config.labelPrefix}.tenant-id`] ? 'assigned' : 'idle',
      }

      this.containers.set(containerId, container)
    }
  }

  private generateContainerId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
