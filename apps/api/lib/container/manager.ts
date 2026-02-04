/**
 * Container Manager
 *
 * Manages the lifecycle of isolated containers in the pool.
 * Uses the ContainerRuntime interface to support multiple backends (Docker, Kubernetes).
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ContainerId,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
  DEFAULT_SECURITY_CONFIG,
  type HealthCheckSpec,
  type PoolContainer,
  type PoolId,
  type ResourceLimits,
  type TenantId,
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

  /** Default network name for container isolation (can be overridden by workload) */
  networkName: string

  /** Default resource limits per container (can be overridden by workload) */
  resources: ResourceLimits

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

  constructor(runtime: ContainerRuntime, managerConfig?: Partial<ContainerManagerConfig>) {
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
        target: workload.volumes.state.containerPath,
        readOnly: workload.volumes.state.mode === 'ro',
      })
    }

    if (workload.volumes.secrets) {
      volumes.push({
        source: secretsDir,
        target: workload.volumes.secrets.containerPath,
        readOnly: workload.volumes.secrets.mode === 'ro',
      })
    }

    if (workload.volumes.comm) {
      volumes.push({
        source: socketDir,
        target: workload.volumes.comm.containerPath,
        readOnly: workload.volumes.comm.mode === 'ro',
      })
    }

    // Add custom volumes
    if (workload.volumes.custom) {
      for (const custom of workload.volumes.custom) {
        const customDir = join(this.config.stateBaseDir, containerId, 'custom', custom.name)
        await mkdir(customDir, { recursive: true })
        volumes.push({
          source: customDir,
          target: custom.containerPath,
          readOnly: custom.mode === 'ro',
        })
      }
    }

    // Build environment variables from workload spec
    const env: ContainerSpec['env'] = Object.entries(workload.environment).map(([name, value]) => ({
      name,
      value,
    }))

    // Merge resource limits (workload overrides manager defaults)
    const resources: ResourceLimits = {
      ...this.config.resources,
      ...workload.resources,
    }

    // Build security config (workload overrides defaults)
    const security = {
      ...DEFAULT_SECURITY_CONFIG,
      readOnlyRootFilesystem: workload.security?.readOnlyRootFilesystem ?? true,
      runAsUser: workload.security?.runAsUser ?? DEFAULT_SECURITY_CONFIG.runAsUser,
    }

    // Build health check from workload spec
    const healthCheck: HealthCheckSpec | undefined = workload.healthCheck
      ? {
          command: workload.healthCheck.command,
          intervalMs: workload.healthCheck.intervalMs,
          timeoutMs: workload.healthCheck.timeoutMs,
          retries: workload.healthCheck.retries,
        }
      : undefined

    // Create container spec
    const spec: ContainerSpec = {
      name: containerName,
      image: workload.image,
      env,
      volumes,
      tmpfs: [
        {
          target: '/tmp',
          sizeBytes: resources.tmpfsSizeMb * 1024 * 1024,
          mode: 0o1777,
        },
        {
          target: '/var/tmp',
          sizeBytes: resources.tmpfsSizeMb * 1024 * 1024,
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

    return container
  }

  /**
   * Release a container from a tenant and prepare for reuse.
   * Wipes state and secrets directories for tenant isolation.
   */
  async releaseContainer(containerId: ContainerId): Promise<void> {
    const container = this.containers.get(containerId)
    if (!container) {
      throw new Error(`Container ${containerId} not found`)
    }

    container.status = 'stopping'

    // Wipe state and secrets directories for tenant isolation
    await Promise.all([
      this.wipeDirectory(container.stateDir),
      this.wipeDirectory(container.secretsDir),
    ])

    container.tenantId = null
    container.status = 'idle'
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
}
