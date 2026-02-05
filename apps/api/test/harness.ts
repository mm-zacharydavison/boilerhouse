/**
 * Integration Test Harness
 *
 * Provides utilities for testing the API with real Docker containers.
 * Supports both API calls and Docker state verification.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ContainerRuntime,
  PoolContainer,
  ContainerInfo as RuntimeContainerInfo,
  TenantId,
  WorkloadSpec,
} from '@boilerhouse/core'
import {
  ActivityRepository,
  AffinityRepository,
  ClaimRepository,
  PoolRepository,
} from '@boilerhouse/db'
import { SyncStatusRepository } from '@boilerhouse/db'
import { DockerRuntime } from '@boilerhouse/docker'
import type { Elysia } from 'elysia'
import { ActivityLog } from '../lib/activity'
import { ContainerManager } from '../lib/container/manager'
import { ContainerPool } from '../lib/container/pool'
import { PoolRegistry } from '../lib/pool/registry'
import { SyncCoordinator } from '../lib/sync/coordinator'
import { RcloneSyncExecutor } from '../lib/sync/rclone'
import { SyncStatusTracker } from '../lib/sync/status'
import { WorkloadRegistry } from '../lib/workload'
import { createServer } from '../src/server'
import { createTestDb } from './db'

/**
 * Test harness configuration
 */
export interface TestHarnessConfig {
  /** Use real Docker runtime (requires Docker daemon) */
  useRealDocker?: boolean
  /** Base directory for test state (defaults to temp dir) */
  baseDir?: string
  /** Workload spec to use for tests */
  workload?: WorkloadSpec
  /** Pool configuration overrides */
  poolConfig?: {
    minSize?: number
    maxSize?: number
    idleTimeoutMs?: number
    affinityTimeoutMs?: number
    acquireTimeoutMs?: number
  }
}

/**
 * Default test workload that runs a simple Alpine container
 */
export const DEFAULT_TEST_WORKLOAD: WorkloadSpec = {
  id: 'test-workload',
  name: 'Test Workload',
  image: 'alpine:latest',
  command: ['sh', '-c', 'while true; do sleep 1; done'],
  volumes: {
    state: { target: '/state', readOnly: false },
    secrets: { target: '/secrets', readOnly: true },
    comm: { target: '/comm', readOnly: false },
  },
  environment: {
    STATE_DIR: '/state',
    TEST_MODE: 'true',
  },
  healthcheck: {
    test: ['CMD', 'true'],
    interval: 5000,
    timeout: 2000,
    retries: 3,
    startPeriod: 1000,
  },
}

/**
 * Result of an API call
 */
export interface ApiResponse<T = unknown> {
  status: number
  data: T
  headers: Headers
}

/**
 * Result of a Docker exec command
 */
export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Integration test harness for API and Docker testing
 */
export class TestHarness {
  private _app: ReturnType<typeof createServer> | null = null
  private _runtime: ContainerRuntime | null = null
  private _manager: ContainerManager | null = null
  private _poolRegistry: PoolRegistry | null = null
  private _workloadRegistry: WorkloadRegistry | null = null
  private _syncCoordinator: SyncCoordinator | null = null
  private _syncStatusTracker: SyncStatusTracker | null = null
  private _activityLog: ActivityLog | null = null
  private _baseDir: string
  private _config: TestHarnessConfig
  private _initialized = false

  constructor(config: TestHarnessConfig = {}) {
    this._config = config
    this._baseDir = config.baseDir ?? join(tmpdir(), `boilerhouse-test-${Date.now()}`)
  }

  /**
   * Initialize the test harness
   */
  async setup(): Promise<void> {
    if (this._initialized) {
      throw new Error('Test harness already initialized')
    }

    // Create base directories
    const stateDir = join(this._baseDir, 'state')
    const secretsDir = join(this._baseDir, 'secrets')
    const socketDir = join(this._baseDir, 'sockets')
    const workloadDir = join(this._baseDir, 'workloads')

    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(secretsDir, { recursive: true }),
      mkdir(socketDir, { recursive: true }),
      mkdir(workloadDir, { recursive: true }),
    ])

    // Create runtime
    if (this._config.useRealDocker) {
      this._runtime = new DockerRuntime()
    } else {
      this._runtime = createMockRuntime()
    }

    // Create in-memory test DB and repos
    const db = createTestDb()
    const claimRepo = new ClaimRepository(db)
    const affinityRepo = new AffinityRepository(db)
    const activityRepo = new ActivityRepository(db)
    const syncStatusRepo = new SyncStatusRepository(db)
    const poolRepo = new PoolRepository(db)

    // Create activity log
    this._activityLog = new ActivityLog(activityRepo)

    // Create container manager
    this._manager = new ContainerManager(
      this._runtime,
      {
        stateBaseDir: stateDir,
        secretsBaseDir: secretsDir,
        socketBaseDir: socketDir,
      },
      claimRepo,
    )

    // Create workload registry and save test workload to file
    const workload = this._config.workload ?? DEFAULT_TEST_WORKLOAD
    const workloadFile = join(workloadDir, `${workload.id}.yaml`)
    await writeFile(
      workloadFile,
      `id: ${workload.id}
name: ${workload.name}
image: ${workload.image}
command: ${JSON.stringify(workload.command)}
volumes:
  state:
    target: ${workload.volumes.state?.target ?? '/state'}
  secrets:
    target: ${workload.volumes.secrets?.target ?? '/secrets'}
    read_only: true
  comm:
    target: ${workload.volumes.comm?.target ?? '/comm'}
environment:
  STATE_DIR: /state
  TEST_MODE: "true"
healthcheck:
  test: ["CMD", "true"]
  interval: 5s
  timeout: 2s
  retries: 3
  start_period: 1s
`,
    )

    this._workloadRegistry = new WorkloadRegistry(workloadDir)
    this._workloadRegistry.load()

    // Create pool registry
    this._poolRegistry = new PoolRegistry(
      this._manager,
      this._workloadRegistry,
      this._activityLog,
      claimRepo,
      affinityRepo,
      poolRepo,
    )

    // Create sync components
    const rcloneExecutor = new RcloneSyncExecutor()
    this._syncStatusTracker = new SyncStatusTracker(syncStatusRepo)
    this._syncCoordinator = new SyncCoordinator(rcloneExecutor, this._syncStatusTracker)

    // Create default pool
    const poolConfig = this._config.poolConfig ?? {}
    this._poolRegistry.createPool('test-pool', workload.id, {
      minSize: poolConfig.minSize ?? 0,
      maxSize: poolConfig.maxSize ?? 5,
      idleTimeoutMs: poolConfig.idleTimeoutMs ?? 60000,
      affinityTimeoutMs: poolConfig.affinityTimeoutMs ?? 5000,
      acquireTimeoutMs: poolConfig.acquireTimeoutMs ?? 1000,
    } as Parameters<typeof this._poolRegistry.createPool>[2])

    // Create server
    this._app = createServer({
      poolRegistry: this._poolRegistry,
      containerManager: this._manager,
      workloadRegistry: this._workloadRegistry,
      syncCoordinator: this._syncCoordinator,
      syncStatusTracker: this._syncStatusTracker,
      activityLog: this._activityLog,
    })

    this._initialized = true
  }

  /**
   * Tear down the test harness
   */
  async teardown(): Promise<void> {
    if (!this._initialized) {
      return
    }

    // Shutdown pool registry (destroys all containers)
    if (this._poolRegistry) {
      await this._poolRegistry.shutdown()
    }

    // Shutdown sync coordinator
    if (this._syncCoordinator) {
      await this._syncCoordinator.shutdown()
    }

    // Clean up base directory
    try {
      await rm(this._baseDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }

    this._initialized = false
  }

  // ==========================================================================
  // API Call Helpers
  // ==========================================================================

  /**
   * Make a GET request to the API
   */
  async get<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path)
  }

  /**
   * Make a POST request to the API
   */
  async post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body)
  }

  /**
   * Make a DELETE request to the API
   */
  async delete<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path)
  }

  /**
   * Make an HTTP request to the API
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    if (!this._app) {
      throw new Error('Test harness not initialized')
    }

    const url = `http://localhost${path}`
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    }

    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }

    const response = await this._app.handle(new Request(url, init))
    const data = (await response.json()) as T

    return {
      status: response.status,
      data,
      headers: response.headers,
    }
  }

  // ==========================================================================
  // Tenant API Shortcuts
  // ==========================================================================

  /**
   * Claim a container for a tenant
   */
  async claimContainer(
    tenantId: TenantId,
    poolId = 'test-pool',
  ): Promise<ApiResponse<{ containerId: string; endpoints: { socket: string } }>> {
    return this.post(`/api/v1/tenants/${tenantId}/claim`, { poolId })
  }

  /**
   * Release a tenant's container
   */
  async releaseContainer(
    tenantId: TenantId,
    options?: { sync?: boolean },
  ): Promise<ApiResponse<{ success: boolean }>> {
    return this.post(`/api/v1/tenants/${tenantId}/release`, options ?? {})
  }

  /**
   * Get tenant status
   */
  async getTenantStatus(
    tenantId: TenantId,
  ): Promise<ApiResponse<{ status: string; containerId?: string }>> {
    return this.get(`/api/v1/tenants/${tenantId}/status`)
  }

  /**
   * Trigger manual sync for a tenant
   */
  async triggerSync(
    tenantId: TenantId,
    direction?: 'upload' | 'download' | 'both',
  ): Promise<ApiResponse<{ success: boolean; results: unknown[] }>> {
    return this.post(`/api/v1/tenants/${tenantId}/sync`, { direction })
  }

  // ==========================================================================
  // Docker State Verification
  // ==========================================================================

  /**
   * Execute a command inside a container
   */
  async exec(containerId: string, command: string[]): Promise<ExecResult> {
    if (!this._runtime) {
      throw new Error('Test harness not initialized')
    }

    const containerName = `container-${containerId}`
    return this._runtime.exec(containerName, command)
  }

  /**
   * Read a file from inside a container
   */
  async readFile(containerId: string, path: string): Promise<string> {
    const result = await this.exec(containerId, ['cat', path])
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${path}: ${result.stderr}`)
    }
    return result.stdout
  }

  /**
   * Write a file inside a container
   */
  async writeFile(containerId: string, path: string, content: string): Promise<void> {
    // Use sh -c to handle the echo and redirect
    const result = await this.exec(containerId, [
      'sh',
      '-c',
      `cat > ${path} << 'TESTEOF'\n${content}\nTESTEOF`,
    ])
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file ${path}: ${result.stderr}`)
    }
  }

  /**
   * List files in a directory inside a container
   */
  async listFiles(containerId: string, path: string): Promise<string[]> {
    const result = await this.exec(containerId, ['ls', '-1', path])
    if (result.exitCode !== 0) {
      // Empty directory or doesn't exist
      if (result.stderr.includes('No such file')) {
        return []
      }
      throw new Error(`Failed to list files in ${path}: ${result.stderr}`)
    }
    return result.stdout.trim().split('\n').filter(Boolean)
  }

  /**
   * Check if a file exists inside a container
   */
  async fileExists(containerId: string, path: string): Promise<boolean> {
    const result = await this.exec(containerId, ['test', '-e', path])
    return result.exitCode === 0
  }

  /**
   * Check if a directory is empty inside a container
   */
  async isDirectoryEmpty(containerId: string, path: string): Promise<boolean> {
    const result = await this.exec(containerId, ['sh', '-c', `[ -z "$(ls -A ${path})" ]`])
    return result.exitCode === 0
  }

  /**
   * Get file stats inside a container
   */
  async stat(containerId: string, path: string): Promise<{ size: number; mtime: string } | null> {
    const result = await this.exec(containerId, ['stat', '-c', '%s %Y', path])
    if (result.exitCode !== 0) {
      return null
    }
    const [size, mtime] = result.stdout.trim().split(' ')
    return {
      size: Number.parseInt(size, 10),
      mtime,
    }
  }

  // ==========================================================================
  // Host State Verification
  // ==========================================================================

  /**
   * List files in a container's host state directory
   */
  async listHostStateFiles(containerId: string): Promise<string[]> {
    const stateDir = join(this._baseDir, 'state', containerId)
    try {
      return await readdir(stateDir)
    } catch {
      return []
    }
  }

  /**
   * Check if a container's host state directory is empty
   */
  async isHostStateEmpty(containerId: string): Promise<boolean> {
    const files = await this.listHostStateFiles(containerId)
    return files.length === 0
  }

  // ==========================================================================
  // Pool and Container State
  // ==========================================================================

  /**
   * Get pool statistics
   */
  getPoolStats(poolId = 'test-pool') {
    const pool = this._poolRegistry?.getPool(poolId)
    return pool?.getStats() ?? null
  }

  /**
   * Get container for a tenant
   */
  getContainerForTenant(tenantId: TenantId, poolId = 'test-pool'): PoolContainer | undefined {
    const pool = this._poolRegistry?.getPool(poolId)
    return pool?.getContainerForTenant(tenantId)
  }

  /**
   * Check if tenant has an assigned container
   */
  hasTenant(tenantId: TenantId, poolId = 'test-pool'): boolean {
    const pool = this._poolRegistry?.getPool(poolId)
    return pool?.hasTenant(tenantId) ?? false
  }

  /**
   * Get activity log entries
   */
  getActivityLog(limit = 100) {
    return this._activityLog?.getEvents(limit) ?? []
  }

  // ==========================================================================
  // Accessors
  // ==========================================================================

  get app() {
    if (!this._app) throw new Error('Test harness not initialized')
    return this._app
  }

  get runtime(): ContainerRuntime {
    if (!this._runtime) throw new Error('Test harness not initialized')
    return this._runtime
  }

  get manager(): ContainerManager {
    if (!this._manager) throw new Error('Test harness not initialized')
    return this._manager
  }

  get poolRegistry(): PoolRegistry {
    if (!this._poolRegistry) throw new Error('Test harness not initialized')
    return this._poolRegistry
  }

  get baseDir(): string {
    return this._baseDir
  }
}

// ==========================================================================
// Mock Runtime for Non-Docker Tests
// ==========================================================================

/**
 * Create a mock container runtime for testing without Docker
 */
function createMockRuntime(): ContainerRuntime {
  let containerCounter = 0
  const containers = new Map<
    string,
    { id: string; name: string; status: string; files: Map<string, string> }
  >()

  return {
    name: 'mock',

    async createContainer(spec) {
      containerCounter++
      const id = `mock-${containerCounter}`
      containers.set(spec.name, {
        id,
        name: spec.name,
        status: 'running',
        files: new Map(),
      })
      return {
        id,
        name: spec.name,
        status: 'running',
        createdAt: new Date(),
        labels: spec.labels ?? {},
      }
    },

    async stopContainer() {},
    async removeContainer(id) {
      containers.delete(id)
    },
    async destroyContainer(id) {
      containers.delete(id)
    },
    async restartContainer() {},

    async getContainer(id): Promise<RuntimeContainerInfo | null> {
      const container = containers.get(id)
      if (!container) return null
      return {
        id: container.id,
        name: container.name,
        status: 'running',
        createdAt: new Date(),
        labels: {},
      }
    },

    async isHealthy(id) {
      return containers.has(id)
    },

    async listContainers(_labels): Promise<RuntimeContainerInfo[]> {
      return Array.from(containers.values()).map((c) => ({
        id: c.id,
        name: c.name,
        status: 'running',
        createdAt: new Date(),
        labels: {},
      }))
    },

    async exec(id, command) {
      const container = containers.get(id)
      if (!container) {
        return { exitCode: 1, stdout: '', stderr: 'Container not found' }
      }

      // Simulate basic file operations for testing
      const cmdStr = command.join(' ')

      // cat file
      if (command[0] === 'cat' && command.length === 2) {
        const content = container.files.get(command[1])
        if (content !== undefined) {
          return { exitCode: 0, stdout: content, stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'No such file' }
      }

      // ls directory
      if (command[0] === 'ls' && command[1] === '-1') {
        const dir = command[2]
        const files = Array.from(container.files.keys())
          .filter((f) => f.startsWith(`${dir}/`))
          .map((f) => f.slice(dir.length + 1).split('/')[0])
        return { exitCode: 0, stdout: [...new Set(files)].join('\n'), stderr: '' }
      }

      // test -e
      if (command[0] === 'test' && command[1] === '-e') {
        const exists = container.files.has(command[2])
        return { exitCode: exists ? 0 : 1, stdout: '', stderr: '' }
      }

      // sh -c with cat > file
      if (command[0] === 'sh' && command[1] === '-c' && cmdStr.includes('cat >')) {
        const match = command[2].match(/cat > ([^\s]+)/)
        if (match) {
          const path = match[1]
          const content = command[2].split('TESTEOF\n')[1]?.split('\n')[0] ?? ''
          container.files.set(path, content)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
      }

      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

/**
 * Create a test harness with default settings
 */
export function createTestHarness(config?: TestHarnessConfig): TestHarness {
  return new TestHarness(config)
}

/**
 * Helper to run tests with a harness (auto setup/teardown)
 */
export async function withTestHarness<T>(
  config: TestHarnessConfig,
  fn: (harness: TestHarness) => Promise<T>,
): Promise<T> {
  const harness = createTestHarness(config)
  await harness.setup()
  try {
    return await fn(harness)
  } finally {
    await harness.teardown()
  }
}
