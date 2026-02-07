/**
 * Container Manager and Pool Tests
 *
 * These tests verify container lifecycle management and pooling.
 * Note: Some tests require Docker to be running.
 */

import { describe, expect, type mock, test } from 'bun:test'
import { DEFAULT_SECURITY_CONFIG } from '@boilerhouse/core'
import { createTestDatabase } from '@boilerhouse/db'
import pino from 'pino'
import type { ContainerRuntime } from '.'
import { createMockContainerRuntime, createPoolId, createWorkloadSpec } from '../../test/fixtures'
import { ContainerManager } from './manager'
import { ContainerPool } from './pool'

const silentLogger = pino({ level: 'silent' })

function setupTest() {
  const db = createTestDatabase()
  const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
  const manager = new ContainerManager(runtime, {
    stateBaseDir: '/tmp/test-states',
    secretsBaseDir: '/tmp/test-secrets',
    socketBaseDir: '/tmp/test-sockets',
  })
  return { db, runtime, manager }
}

describe('ContainerManager', () => {
  describe('Unit Tests (mocked runtime)', () => {
    test('generateContainerId creates unique IDs', () => {
      const { manager } = setupTest()

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

    test('getRuntime returns the runtime instance', () => {
      const { manager, runtime } = setupTest()

      expect(manager.getRuntime()).toBe(runtime)
      expect(manager.getRuntime().name).toBe('mock')
    })

    test('paths are computed deterministically', () => {
      const { manager } = setupTest()

      expect(manager.getStateDir('test-id')).toBe('/tmp/test-states/test-id')
      expect(manager.getSecretsDir('test-id')).toBe('/tmp/test-secrets/test-id')
      expect(manager.getSocketPath('test-id')).toBe('/tmp/test-sockets/test-id/app.sock')
    })
  })
})

describe('ContainerPool', () => {
  describe('Unit Tests (mocked runtime)', () => {
    test('acquireForTenant returns same container for same tenant', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      const container1 = await pool.acquireForTenant('tenant-pool-1')
      const container2 = await pool.acquireForTenant('tenant-pool-1')

      expect(container1.containerId).toBe(container2.containerId)

      await pool.drain()
    })

    test('acquireForTenant returns different containers for different tenants', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      const container1 = await pool.acquireForTenant('tenant-a')
      const container2 = await pool.acquireForTenant('tenant-b')

      expect(container1.containerId).not.toBe(container2.containerId)

      await pool.drain()
    })

    test('hasTenant returns correct status', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      expect(pool.hasTenant('tenant-check')).toBe(false)

      await pool.acquireForTenant('tenant-check')
      expect(pool.hasTenant('tenant-check')).toBe(true)

      await pool.drain()
    })

    test('acquireForTenant returns same container when tenant reclaims (no wipe)', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      const container1 = await pool.acquireForTenant('tenant-affinity')
      await pool.releaseForTenant('tenant-affinity')

      // Reclaim - should get same container via lastTenantId match
      const container2 = await pool.acquireForTenant('tenant-affinity')
      expect(container2.containerId).toBe(container1.containerId)

      await pool.drain()
    })

    test('different tenant gets same container but wipe happens', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 1,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      // Tenant A claims and releases
      const containerA = await pool.acquireForTenant('tenant-A')
      await pool.releaseForTenant('tenant-A')

      // Tenant B claims - with maxSize=1, gets same container (wiped)
      const containerB = await pool.acquireForTenant('tenant-B')
      expect(containerB.containerId).toBe(containerA.containerId)

      await pool.drain()
    })

    test('getStats returns pool statistics', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 10,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      const stats = pool.getStats()
      expect(stats.minIdle).toBe(0)
      expect(stats.max).toBe(10)
      expect(typeof stats.size).toBe('number')
      expect(typeof stats.available).toBe('number')
      expect(typeof stats.borrowed).toBe('number')

      await pool.drain()
    })

    test('getTenantsWithClaims returns all tenant IDs that have claims', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      await pool.acquireForTenant('tenant-x')
      await pool.acquireForTenant('tenant-y')

      const tenants = pool.getTenantsWithClaims()
      expect(tenants).toContain('tenant-x')
      expect(tenants).toContain('tenant-y')
      expect(tenants).toHaveLength(2)

      await pool.drain()
    })

    test('getStats reflects claimed count correctly', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      await pool.acquireForTenant('tenant-stats-1')
      await pool.acquireForTenant('tenant-stats-2')

      const stats = pool.getStats()
      expect(stats.borrowed).toBe(2)
      expect(stats.size).toBe(2)
      expect(stats.available).toBe(0)

      await pool.drain()
    })

    test('releaseForTenant returns container to idle', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      await pool.acquireForTenant('tenant-release')
      const statsBefore = pool.getStats()
      expect(statsBefore.borrowed).toBe(1)

      await pool.releaseForTenant('tenant-release')
      const statsAfter = pool.getStats()
      // Container goes to idle
      expect(statsAfter.borrowed).toBe(0)
      expect(statsAfter.available).toBe(1)
      expect(statsAfter.size).toBe(1)

      await pool.drain()
    })

    test('getAllContainers returns all pool containers', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minIdle: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
        silentLogger,
      )

      await pool.acquireForTenant('tenant-all-1')
      await pool.acquireForTenant('tenant-all-2')

      const allContainers = pool.getAllContainers()
      expect(allContainers).toHaveLength(2)

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
    const { manager, runtime } = setupTest()

    const poolId = createPoolId()
    const workload = createWorkloadSpec()
    await manager.createContainer(workload, poolId)

    // Verify createContainer was called with security config
    const createMock = runtime.createContainer as ReturnType<typeof mock>
    expect(createMock).toHaveBeenCalled()

    const callArgs = createMock.mock.calls[0][0]
    expect(callArgs.security.readOnlyRootFilesystem).toBe(true)
    expect(callArgs.security.dropAllCapabilities).toBe(true)
    expect(callArgs.security.noNewPrivileges).toBe(true)
  })

  test('container spec includes DNS configuration', async () => {
    const { manager, runtime } = setupTest()

    const poolId = createPoolId()
    const workload = createWorkloadSpec()
    await manager.createContainer(workload, poolId)

    const createMock = runtime.createContainer as ReturnType<typeof mock>
    const callArgs = createMock.mock.calls[0][0]

    expect(callArgs.network.dnsServers).toContain('8.8.8.8')
    expect(callArgs.network.dnsServers).toContain('1.1.1.1')
  })

  test('workload can override security settings', async () => {
    const { manager, runtime } = setupTest()

    const poolId = createPoolId()
    const workload = createWorkloadSpec({
      readOnly: false,
      user: 1000,
    })
    await manager.createContainer(workload, poolId)

    const createMock = runtime.createContainer as ReturnType<typeof mock>
    const callArgs = createMock.mock.calls[0][0]

    expect(callArgs.security.readOnlyRootFilesystem).toBe(false)
    expect(callArgs.security.runAsUser).toBe(1000)
  })

  test('workload environment variables are passed to container', async () => {
    const { manager, runtime } = setupTest()

    const poolId = createPoolId()
    const workload = createWorkloadSpec({
      environment: {
        MY_VAR: 'my-value',
        ANOTHER_VAR: 'another-value',
      },
    })
    await manager.createContainer(workload, poolId)

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
      restartContainer: async () => {},
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

    const poolId = createPoolId()
    const workload = createWorkloadSpec()
    const container = await manager.createContainer(workload, poolId)
    expect(container.status).toBe('idle')
  })
})
