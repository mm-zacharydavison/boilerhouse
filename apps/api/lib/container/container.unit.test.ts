/**
 * Container Manager and Pool Tests
 *
 * These tests verify container lifecycle management and pooling.
 * Note: Some tests require Docker to be running.
 */

import { describe, expect, mock, test } from 'bun:test'
import type { PoolId, WorkloadId, WorkloadSpec } from '@boilerhouse/core'
import { ContainerManager, ContainerPool, type ContainerRuntime, DEFAULT_SECURITY_CONFIG } from '.'

/**
 * Create a test workload spec with sensible defaults.
 */
function createTestWorkload(overrides?: Partial<WorkloadSpec>): WorkloadSpec {
  return {
    id: 'test-workload' as WorkloadId,
    name: 'Test Workload',
    image: 'alpine:latest',
    volumes: {
      state: { containerPath: '/state', mode: 'rw' },
      secrets: { containerPath: '/secrets', mode: 'ro' },
      comm: { containerPath: '/comm', mode: 'rw' },
    },
    environment: {
      STATE_DIR: '/state',
      SOCKET_PATH: '/comm/app.sock',
    },
    healthCheck: {
      command: ['true'],
      intervalMs: 30000,
      timeoutMs: 5000,
      retries: 3,
    },
    ...overrides,
  }
}

const TEST_POOL_ID = 'test-pool' as PoolId

// Mock ContainerRuntime for unit tests
function createMockRuntime(): ContainerRuntime {
  let containerCount = 0

  return {
    name: 'mock',

    createContainer: mock(async (spec) => {
      containerCount++
      return {
        id: `mock-container-${containerCount}`,
        name: spec.name,
        status: 'running' as const,
        createdAt: new Date(),
        startedAt: new Date(),
        labels: spec.labels,
      }
    }),

    stopContainer: mock(async () => {}),

    removeContainer: mock(async () => {}),

    destroyContainer: mock(async () => {}),

    getContainer: mock(async (id) => ({
      id,
      name: `container-${id}`,
      status: 'running' as const,
      createdAt: new Date(),
      startedAt: new Date(),
      labels: {},
    })),

    isHealthy: mock(async () => true),

    listContainers: mock(async () => []),

    exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  }
}

describe('ContainerManager', () => {
  describe('Unit Tests (mocked runtime)', () => {
    test('generateContainerId creates unique IDs', () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      // Access private method for testing
      const id1 = (
        manager as unknown as { generateContainerId: () => string }
      ).generateContainerId()
      const id2 = (
        manager as unknown as { generateContainerId: () => string }
      ).generateContainerId()

      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    })

    test('getContainersByStatus filters correctly', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      // Create a container
      const workload = createTestWorkload()
      const container = await manager.createContainer(workload, TEST_POOL_ID)
      expect(container.status).toBe('idle')

      const idleContainers = manager.getContainersByStatus('idle')
      expect(idleContainers).toHaveLength(1)
      expect(idleContainers[0].containerId).toBe(container.containerId)

      const assignedContainers = manager.getContainersByStatus('assigned')
      expect(assignedContainers).toHaveLength(0)
    })

    test('assignToTenant updates container state', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const workload = createTestWorkload()
      const container = await manager.createContainer(workload, TEST_POOL_ID)
      expect(container.tenantId).toBeNull()

      await manager.assignToTenant(container.containerId, 'tenant-123')

      const updated = manager.getContainer(container.containerId)
      expect(updated?.tenantId).toBe('tenant-123')
      expect(updated?.status).toBe('assigned')
    })

    test('getContainerByTenant finds correct container', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const workload = createTestWorkload()
      const container = await manager.createContainer(workload, TEST_POOL_ID)
      await manager.assignToTenant(container.containerId, 'tenant-456')

      const found = manager.getContainerByTenant('tenant-456')
      expect(found?.containerId).toBe(container.containerId)

      const notFound = manager.getContainerByTenant('tenant-999')
      expect(notFound).toBeUndefined()
    })

    test('recordActivity updates lastActivity', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const workload = createTestWorkload()
      const container = await manager.createContainer(workload, TEST_POOL_ID)
      const originalTime = container.lastActivity.getTime()

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10))

      manager.recordActivity(container.containerId)

      const updated = manager.getContainer(container.containerId)
      expect(updated?.lastActivity.getTime()).toBeGreaterThan(originalTime)
    })

    test('getStaleContainers returns containers exceeding idle timeout', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const workload = createTestWorkload()
      const container = await manager.createContainer(workload, TEST_POOL_ID)
      await manager.assignToTenant(container.containerId, 'tenant-stale')

      // Set lastActivity to past
      const updated = manager.getContainer(container.containerId)
      if (updated) {
        updated.lastActivity = new Date(Date.now() - 60000) // 60 seconds ago
      }

      const stale = manager.getStaleContainers(30000) // 30 second timeout
      expect(stale).toHaveLength(1)
      expect(stale[0].containerId).toBe(container.containerId)

      const notStale = manager.getStaleContainers(120000) // 2 minute timeout
      expect(notStale).toHaveLength(0)
    })

    test('getRuntime returns the runtime instance', () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      expect(manager.getRuntime()).toBe(runtime)
      expect(manager.getRuntime().name).toBe('mock')
    })
  })
})

describe('ContainerPool', () => {
  describe('Unit Tests (mocked runtime)', () => {
    test('acquireForTenant returns same container for same tenant', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const pool = new ContainerPool(manager, {
        workload: createTestWorkload(),
        poolId: TEST_POOL_ID,
        minSize: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0, // Disable auto-eviction for tests
        acquireTimeoutMs: 5000,
      })

      const container1 = await pool.acquireForTenant('tenant-pool-1')
      const container2 = await pool.acquireForTenant('tenant-pool-1')

      expect(container1.containerId).toBe(container2.containerId)

      await pool.drain()
    })

    test('acquireForTenant returns different containers for different tenants', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const pool = new ContainerPool(manager, {
        workload: createTestWorkload(),
        poolId: TEST_POOL_ID,
        minSize: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      })

      const container1 = await pool.acquireForTenant('tenant-a')
      const container2 = await pool.acquireForTenant('tenant-b')

      expect(container1.containerId).not.toBe(container2.containerId)

      await pool.drain()
    })

    test('hasTenant returns correct status', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const pool = new ContainerPool(manager, {
        workload: createTestWorkload(),
        poolId: TEST_POOL_ID,
        minSize: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      })

      expect(pool.hasTenant('tenant-check')).toBe(false)

      await pool.acquireForTenant('tenant-check')
      expect(pool.hasTenant('tenant-check')).toBe(true)

      await pool.drain()
    })

    test('getStats returns pool statistics', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const pool = new ContainerPool(manager, {
        workload: createTestWorkload(),
        poolId: TEST_POOL_ID,
        minSize: 0,
        maxSize: 10,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      })

      const stats = pool.getStats()
      expect(stats.min).toBe(0)
      expect(stats.max).toBe(10)
      expect(typeof stats.size).toBe('number')
      expect(typeof stats.available).toBe('number')
      expect(typeof stats.borrowed).toBe('number')

      await pool.drain()
    })

    test('getAssignedTenants returns all assigned tenant IDs', async () => {
      const runtime = createMockRuntime()
      const manager = new ContainerManager(runtime, {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      })

      const pool = new ContainerPool(manager, {
        workload: createTestWorkload(),
        poolId: TEST_POOL_ID,
        minSize: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      })

      await pool.acquireForTenant('tenant-x')
      await pool.acquireForTenant('tenant-y')

      const tenants = pool.getAssignedTenants()
      expect(tenants).toContain('tenant-x')
      expect(tenants).toContain('tenant-y')
      expect(tenants).toHaveLength(2)

      await pool.drain()
    })
  })
})

describe('Security Configuration', () => {
  test('DEFAULT_SECURITY_CONFIG has expected values', () => {
    expect(DEFAULT_SECURITY_CONFIG.readOnlyRootFilesystem).toBe(true)
    expect(DEFAULT_SECURITY_CONFIG.dropAllCapabilities).toBe(true)
    expect(DEFAULT_SECURITY_CONFIG.noNewPrivileges).toBe(true)
    expect(DEFAULT_SECURITY_CONFIG.runAsNonRoot).toBe(true)
  })

  test('container spec includes security configuration', async () => {
    const runtime = createMockRuntime()
    const manager = new ContainerManager(runtime, {
      stateBaseDir: '/tmp/test-states',
      secretsBaseDir: '/tmp/test-secrets',
      socketBaseDir: '/tmp/test-sockets',
    })

    const workload = createTestWorkload()
    await manager.createContainer(workload, TEST_POOL_ID)

    // Verify createContainer was called with security config
    const createMock = runtime.createContainer as ReturnType<typeof mock>
    expect(createMock).toHaveBeenCalled()

    const callArgs = createMock.mock.calls[0][0]
    expect(callArgs.security.readOnlyRootFilesystem).toBe(true)
    expect(callArgs.security.dropAllCapabilities).toBe(true)
    expect(callArgs.security.noNewPrivileges).toBe(true)
  })

  test('container spec includes DNS configuration', async () => {
    const runtime = createMockRuntime()
    const manager = new ContainerManager(runtime, {
      stateBaseDir: '/tmp/test-states',
      secretsBaseDir: '/tmp/test-secrets',
      socketBaseDir: '/tmp/test-sockets',
    })

    const workload = createTestWorkload()
    await manager.createContainer(workload, TEST_POOL_ID)

    const createMock = runtime.createContainer as ReturnType<typeof mock>
    const callArgs = createMock.mock.calls[0][0]

    expect(callArgs.network.dnsServers).toContain('8.8.8.8')
    expect(callArgs.network.dnsServers).toContain('1.1.1.1')
  })

  test('workload can override security settings', async () => {
    const runtime = createMockRuntime()
    const manager = new ContainerManager(runtime, {
      stateBaseDir: '/tmp/test-states',
      secretsBaseDir: '/tmp/test-secrets',
      socketBaseDir: '/tmp/test-sockets',
    })

    const workload = createTestWorkload({
      security: {
        readOnlyRootFilesystem: false,
        runAsUser: 1000,
      },
    })
    await manager.createContainer(workload, TEST_POOL_ID)

    const createMock = runtime.createContainer as ReturnType<typeof mock>
    const callArgs = createMock.mock.calls[0][0]

    expect(callArgs.security.readOnlyRootFilesystem).toBe(false)
    expect(callArgs.security.runAsUser).toBe(1000)
  })

  test('workload environment variables are passed to container', async () => {
    const runtime = createMockRuntime()
    const manager = new ContainerManager(runtime, {
      stateBaseDir: '/tmp/test-states',
      secretsBaseDir: '/tmp/test-secrets',
      socketBaseDir: '/tmp/test-sockets',
    })

    const workload = createTestWorkload({
      environment: {
        MY_VAR: 'my-value',
        ANOTHER_VAR: 'another-value',
      },
    })
    await manager.createContainer(workload, TEST_POOL_ID)

    const createMock = runtime.createContainer as ReturnType<typeof mock>
    const callArgs = createMock.mock.calls[0][0]

    expect(callArgs.env).toContainEqual({ name: 'MY_VAR', value: 'my-value' })
    expect(callArgs.env).toContainEqual({ name: 'ANOTHER_VAR', value: 'another-value' })
  })
})

describe('ContainerRuntime abstraction', () => {
  test('manager works with any ContainerRuntime implementation', async () => {
    // This test verifies that the manager only depends on the interface
    const customRuntime: ContainerRuntime = {
      name: 'custom-runtime',
      createContainer: async (spec: { name: string; labels: Record<string, string> }) => ({
        id: 'custom-id',
        name: spec.name,
        status: 'running',
        createdAt: new Date(),
        labels: spec.labels,
      }),
      stopContainer: async () => {},
      removeContainer: async () => {},
      destroyContainer: async () => {},
      getContainer: async () => null,
      isHealthy: async () => true,
      listContainers: async () => [],
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }

    const manager = new ContainerManager(customRuntime, {
      stateBaseDir: '/tmp/test-states',
      secretsBaseDir: '/tmp/test-secrets',
      socketBaseDir: '/tmp/test-sockets',
    })

    expect(manager.getRuntime().name).toBe('custom-runtime')

    const workload = createTestWorkload()
    const container = await manager.createContainer(workload, TEST_POOL_ID)
    expect(container.status).toBe('idle')
  })
})
