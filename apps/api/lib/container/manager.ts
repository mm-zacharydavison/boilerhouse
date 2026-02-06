/**
 * Container Manager
 *
 * Manages the lifecycle of isolated containers in the pool.
 * Uses the ContainerRuntime interface to support multiple backends (Docker, Kubernetes).
 *
 * Container existence is tracked by Docker (source of truth).
 * Tenant claims are tracked in SQLite via Drizzle ORM.
 * Paths are computed deterministically from containerId.
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type ContainerId,
  type ContainerRuntime,
  type ContainerSpec,
  DEFAULT_SECURITY_CONFIG,
  type DefaultResourceLimits,
  type HealthCheckSpec,
  type PoolContainer,
  type PoolId,
  type TenantId,
  type WorkloadSpec,
} from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { eq, lt } from 'drizzle-orm'
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
  private db: DrizzleDb

  constructor(
    runtime: ContainerRuntime,
    managerConfig: Partial<ContainerManagerConfig> | undefined,
    db: DrizzleDb,
  ) {
    this.runtime = runtime
    this.config = { ...DEFAULT_CONFIG, ...managerConfig }
    this.db = db
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
   * Claim a container for a tenant.
   * Mutates the passed-in PoolContainer object (for generic-pool compatibility).
   */
  async claimForTenant(
    containerId: ContainerId,
    tenantId: TenantId,
    poolContainer: PoolContainer,
    envVars?: Record<string, string>,
  ): Promise<PoolContainer> {
    if (poolContainer.tenantId !== null) {
      throw new Error(
        `Container ${containerId} already claimed by tenant ${poolContainer.tenantId}`,
      )
    }

    if (envVars && Object.keys(envVars).length > 0) {
      console.warn('Environment variables should be passed via secrets files, not container env')
    }

    poolContainer.tenantId = tenantId
    poolContainer.status = 'claimed'
    poolContainer.lastActivity = new Date()

    this.db
      .insert(schema.claims)
      .values({
        containerId,
        tenantId,
        poolId: poolContainer.poolId,
        lastActivity: poolContainer.lastActivity,
      })
      .onConflictDoUpdate({
        target: schema.claims.containerId,
        set: {
          tenantId,
          poolId: poolContainer.poolId,
          lastActivity: poolContainer.lastActivity,
        },
      })
      .run()

    return poolContainer
  }

  /**
   * Release a container from a tenant.
   * Mutates the passed-in PoolContainer object.
   */
  async releaseContainer(containerId: ContainerId, poolContainer: PoolContainer): Promise<void> {
    poolContainer.lastTenantId = poolContainer.tenantId
    poolContainer.tenantId = null
    poolContainer.status = 'idle'
    poolContainer.lastActivity = new Date()

    this.db.delete(schema.claims).where(eq(schema.claims.containerId, containerId)).run()
  }

  /**
   * Wipe container state for a new tenant.
   * Called when a container is claimed by a different tenant than its lastTenantId.
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
   * Stop and remove a container completely
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

    this.db.delete(schema.claims).where(eq(schema.claims.containerId, containerId)).run()
  }

  /**
   * Get container claimed by a tenant (from DB).
   */
  getContainerByTenant(tenantId: TenantId): PoolContainer | null {
    const claim = this.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.tenantId, tenantId))
      .get()
    if (!claim) return null

    return {
      containerId: claim.containerId,
      tenantId: claim.tenantId,
      poolId: claim.poolId,
      socketPath: this.getSocketPath(claim.containerId),
      stateDir: this.getStateDir(claim.containerId),
      secretsDir: this.getSecretsDir(claim.containerId),
      lastActivity: claim.lastActivity,
      status: 'claimed',
    }
  }

  /**
   * Update last activity timestamp in the claim.
   */
  recordActivity(containerId: ContainerId): void {
    this.db
      .update(schema.claims)
      .set({ lastActivity: new Date() })
      .where(eq(schema.claims.containerId, containerId))
      .run()
  }

  /**
   * Check container health via runtime
   */
  async isHealthy(containerId: ContainerId): Promise<boolean> {
    const containerName = `container-${containerId}`
    return this.runtime.isHealthy(containerName)
  }

  /**
   * Get claimed containers that have exceeded the idle timeout (from claims DB).
   */
  getStaleContainers(maxIdleMs: number): { containerId: ContainerId; tenantId: TenantId }[] {
    const threshold = new Date(Date.now() - maxIdleMs)
    return this.db
      .select({
        containerId: schema.claims.containerId,
        tenantId: schema.claims.tenantId,
      })
      .from(schema.claims)
      .where(lt(schema.claims.lastActivity, threshold))
      .all()
  }

  /**
   * Get the label prefix used for container tracking.
   */
  getLabelPrefix(): string {
    return this.config.labelPrefix
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
