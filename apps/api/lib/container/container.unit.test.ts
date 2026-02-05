/**
 * Container Manager and Pool Tests
 *
 * These tests verify container lifecycle management and pooling.
 * Note: Some tests require Docker to be running.
 */

import type { Database } from 'bun:sqlite'
import { describe, expect, type mock, test } from 'bun:test'
import type { DrizzleDb } from '@boilerhouse/db'
import { ContainerManager, ContainerPool, type ContainerRuntime, DEFAULT_SECURITY_CONFIG } from '.'
import { createTestDb } from '../../test/db'
import { createMockContainerRuntime, createPoolId, createWorkloadSpec } from '../../test/fixtures'

function setupTest() {
  const db = createTestDb()
  const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
  const manager = new ContainerManager(
    runtime,
    {
      stateBaseDir: '/tmp/test-states',
      secretsBaseDir: '/tmp/test-secrets',
      socketBaseDir: '/tmp/test-sockets',
    },
    db,
  )
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

    test('claimForTenant updates container state', async () => {
      const { manager } = setupTest()

      const poolId = createPoolId()
      const workload = createWorkloadSpec()
      const container = await manager.createContainer(workload, poolId)
      expect(container.tenantId).toBeNull()

      await manager.claimForTenant(container.containerId, 'tenant-123', container)

      expect(container.tenantId).toBe('tenant-123')
      expect(container.status).toBe('claimed')
    })

    test('getContainerByTenant finds correct container', async () => {
      const { manager } = setupTest()

      const poolId = createPoolId()
      const workload = createWorkloadSpec()
      const container = await manager.createContainer(workload, poolId)
      await manager.claimForTenant(container.containerId, 'tenant-456', container)

      const found = manager.getContainerByTenant('tenant-456')
      expect(found?.containerId).toBe(container.containerId)

      const notFound = manager.getContainerByTenant('tenant-999')
      expect(notFound).toBeNull()
    })

    test('recordActivity updates claim in DB', async () => {
      const { manager } = setupTest()

      const poolId = createPoolId()
      const workload = createWorkloadSpec()
      const container = await manager.createContainer(workload, poolId)
      await manager.claimForTenant(container.containerId, 'tenant-activity', container)

      const beforeContainer = manager.getContainerByTenant('tenant-activity')
      if (!beforeContainer) throw new Error('Expected beforeContainer')

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10))

      manager.recordActivity(container.containerId)

      const afterContainer = manager.getContainerByTenant('tenant-activity')
      if (!afterContainer) throw new Error('Expected afterContainer')
      expect(afterContainer.lastActivity.getTime()).toBeGreaterThanOrEqual(
        beforeContainer.lastActivity.getTime(),
      )
    })

    test('getStaleContainers returns containers exceeding idle timeout', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const workload = createWorkloadSpec()
      const container = await manager.createContainer(workload, poolId)
      await manager.claimForTenant(container.containerId, 'tenant-stale', container)

      // Manually update last_activity to the past via raw SQLite client
      const rawDb = (db as unknown as { $client: Database }).$client
      rawDb.run('UPDATE claims SET last_activity = ? WHERE container_id = ?', [
        Date.now() - 60000,
        container.containerId,
      ])

      const stale = manager.getStaleContainers(30000) // 30 second timeout
      expect(stale).toHaveLength(1)
      expect(stale[0].containerId).toBe(container.containerId)

      const notStale = manager.getStaleContainers(120000) // 2 minute timeout
      expect(notStale).toHaveLength(0)
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
          minSize: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0, // Disable auto-eviction for tests
          acquireTimeoutMs: 5000,
        },
        db,
      )

      const { container: container1 } = await pool.acquireForTenant('tenant-pool-1')
      const { container: container2 } = await pool.acquireForTenant('tenant-pool-1')

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
          minSize: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
      )

      const { container: container1 } = await pool.acquireForTenant('tenant-a')
      const { container: container2 } = await pool.acquireForTenant('tenant-b')

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
          minSize: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
      )

      expect(pool.hasTenant('tenant-check')).toBe(false)

      await pool.acquireForTenant('tenant-check')
      expect(pool.hasTenant('tenant-check')).toBe(true)

      await pool.drain()
    })

    test('acquireForTenant returns affinity match when tenant reclaims their container', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minSize: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
          affinityTimeoutMs: 60000, // 60 seconds for test
        },
        db,
      )

      // First claim - should not be affinity match
      const { container: container1, isAffinityMatch: match1 } =
        await pool.acquireForTenant('tenant-affinity')
      expect(match1).toBe(false)

      // Release the container
      await pool.releaseForTenant('tenant-affinity')

      // Reclaim - should get same container with affinity match
      const { container: container2, isAffinityMatch: match2 } =
        await pool.acquireForTenant('tenant-affinity')
      expect(match2).toBe(true)
      expect(container2.containerId).toBe(container1.containerId)

      await pool.drain()
    })

    test('acquireForTenant returns no affinity for different tenant', async () => {
      const { manager, db } = setupTest()

      const poolId = createPoolId()
      const pool = new ContainerPool(
        manager,
        {
          workload: createWorkloadSpec(),
          poolId,
          minSize: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
          affinityTimeoutMs: 60000,
        },
        db,
      )

      // Tenant A claims and releases
      const { container: containerA } = await pool.acquireForTenant('tenant-A')
      await pool.releaseForTenant('tenant-A')

      // Tenant B claims - should not get affinity match
      const { container: containerB, isAffinityMatch: matchB } =
        await pool.acquireForTenant('tenant-B')
      expect(matchB).toBe(false)
      // Should get a different container (A's is reserved)
      expect(containerB.containerId).not.toBe(containerA.containerId)

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
          minSize: 0,
          maxSize: 10,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
      )

      const stats = pool.getStats()
      expect(stats.min).toBe(0)
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
          minSize: 0,
          maxSize: 5,
          idleTimeoutMs: 60000,
          evictionIntervalMs: 0,
          acquireTimeoutMs: 5000,
        },
        db,
      )

      await pool.acquireForTenant('tenant-x')
      await pool.acquireForTenant('tenant-y')

      const tenants = pool.getTenantsWithClaims()
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
    const db = createTestDb()

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

    const manager = new ContainerManager(
      customRuntime,
      {
        stateBaseDir: '/tmp/test-states',
        secretsBaseDir: '/tmp/test-secrets',
        socketBaseDir: '/tmp/test-sockets',
      },
      db,
    )

    expect(manager.getRuntime().name).toBe('custom-runtime')

    const poolId = createPoolId()
    const workload = createWorkloadSpec()
    const container = await manager.createContainer(workload, poolId)
    expect(container.status).toBe('idle')
  })
})
