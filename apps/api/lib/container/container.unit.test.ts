/**
 * Container Manager and Pool Tests
 *
 * These tests verify container lifecycle management and pooling.
 * Note: Some tests require Docker to be running.
 */

import { describe, expect, type mock, mock as mockFn, test } from 'bun:test'

const chownMock = mockFn(() => Promise.resolve())

mockFn.module('node:fs/promises', () => {
  const actual = require('node:fs/promises')
  return {
    ...actual,
    chown: chownMock,
  }
})
import { DEFAULT_SECURITY_CONFIG, TenantId } from '@boilerhouse/core'
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

      const container1 = await pool.acquireForTenant(TenantId('tenant-pool-1'))
      const container2 = await pool.acquireForTenant(TenantId('tenant-pool-1'))

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

      const container1 = await pool.acquireForTenant(TenantId('tenant-a'))
      const container2 = await pool.acquireForTenant(TenantId('tenant-b'))

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

      expect(pool.hasTenant(TenantId('tenant-check'))).toBe(false)

      await pool.acquireForTenant(TenantId('tenant-check'))
      expect(pool.hasTenant(TenantId('tenant-check'))).toBe(true)

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

      const container1 = await pool.acquireForTenant(TenantId('tenant-affinity'))
      await pool.releaseForTenant(TenantId('tenant-affinity'))

      // Reclaim - should get same container via lastTenantId match
      const container2 = await pool.acquireForTenant(TenantId('tenant-affinity'))
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
      const containerA = await pool.acquireForTenant(TenantId('tenant-A'))
      await pool.releaseForTenant(TenantId('tenant-A'))

      // Tenant B claims - with maxSize=1, gets same container (wiped)
      const containerB = await pool.acquireForTenant(TenantId('tenant-B'))
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

      await pool.acquireForTenant(TenantId('tenant-x'))
      await pool.acquireForTenant(TenantId('tenant-y'))

      const tenants = pool.getTenantsWithClaims()
      expect(tenants).toContain(TenantId('tenant-x'))
      expect(tenants).toContain(TenantId('tenant-y'))
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

      await pool.acquireForTenant(TenantId('tenant-stats-1'))
      await pool.acquireForTenant(TenantId('tenant-stats-2'))

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

      await pool.acquireForTenant(TenantId('tenant-release'))
      const statsBefore = pool.getStats()
      expect(statsBefore.borrowed).toBe(1)

      await pool.releaseForTenant(TenantId('tenant-release'))
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

      await pool.acquireForTenant(TenantId('tenant-all-1'))
      await pool.acquireForTenant(TenantId('tenant-all-2'))

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

  test('volume directories are chowned when user is specified', async () => {
    const { manager } = setupTest()
    chownMock.mockClear()

    const poolId = createPoolId()
    const workload = createWorkloadSpec({ user: 1000 })
    await manager.createContainer(workload, poolId)

    // state, secrets, and socket dirs should all be chowned
    const chownCalls = chownMock.mock.calls
    expect(chownCalls.length).toBe(3)
    for (const call of chownCalls) {
      expect(call[1]).toBe(1000)
      expect(call[2]).toBe(1000)
    }
  })

  test('string user is parsed and applied to security and chown', async () => {
    const { manager, runtime } = setupTest()
    chownMock.mockClear()

    const poolId = createPoolId()
    const workload = createWorkloadSpec({ user: '1000' as unknown as number })
    await manager.createContainer(workload, poolId)

    // runAsUser should be parsed to number
    const createMock = runtime.createContainer as ReturnType<typeof mock>
    const callArgs = createMock.mock.calls[0][0]
    expect(callArgs.security.runAsUser).toBe(1000)

    // chown should fire with parsed uid
    expect(chownMock.mock.calls.length).toBe(3)
    for (const call of chownMock.mock.calls) {
      expect(call[1]).toBe(1000)
      expect(call[2]).toBe(1000)
    }
  })

  test('volume directories are not chowned when user is not specified', async () => {
    const { manager } = setupTest()
    chownMock.mockClear()

    const poolId = createPoolId()
    const workload = createWorkloadSpec()
    await manager.createContainer(workload, poolId)

    expect(chownMock).not.toHaveBeenCalled()
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

describe('applySeed', () => {
  test('copies seed files to empty state directory', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const baseDir = await mkdtemp(join(tmpdir(), 'seed-test-'))
    const stateBaseDir = join(baseDir, 'state')
    const secretsBaseDir = join(baseDir, 'secrets')
    const socketBaseDir = join(baseDir, 'sockets')
    const seedDir = join(baseDir, 'seed')

    const { mkdir } = await import('node:fs/promises')
    await mkdir(stateBaseDir, { recursive: true })
    await mkdir(secretsBaseDir, { recursive: true })
    await mkdir(socketBaseDir, { recursive: true })
    await mkdir(seedDir, { recursive: true })

    // Create seed files
    await writeFile(join(seedDir, 'config.json'), '{"key":"value"}')
    await writeFile(join(seedDir, 'README.md'), '# Hello')

    const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
    const manager = new ContainerManager(runtime, {
      stateBaseDir,
      secretsBaseDir,
      socketBaseDir,
    })

    // Create a container to get a real containerId with host dirs
    const workload = createWorkloadSpec({
      volumes: {
        state: { target: '/state', readOnly: false, seed: seedDir },
      },
    })
    const poolId = createPoolId()
    const container = await manager.createContainer(workload, poolId)

    // State dir should be empty before seed
    const { readdir } = await import('node:fs/promises')
    const filesBefore = await readdir(manager.getStateDir(container.containerId))
    expect(filesBefore).toHaveLength(0)

    // Apply seed
    await manager.applySeed(container.containerId, workload)

    // Seed files should now exist
    const filesAfter = await readdir(manager.getStateDir(container.containerId))
    expect(filesAfter).toContain('config.json')
    expect(filesAfter).toContain('README.md')

    // Clean up
    const { rm } = await import('node:fs/promises')
    await rm(baseDir, { recursive: true, force: true })
  })

  test('overwrites existing files when seeding', async () => {
    const { mkdtemp, writeFile, mkdir, readdir, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const baseDir = await mkdtemp(join(tmpdir(), 'seed-test-'))
    const stateBaseDir = join(baseDir, 'state')
    const secretsBaseDir = join(baseDir, 'secrets')
    const socketBaseDir = join(baseDir, 'sockets')
    const seedDir = join(baseDir, 'seed')

    await mkdir(stateBaseDir, { recursive: true })
    await mkdir(secretsBaseDir, { recursive: true })
    await mkdir(socketBaseDir, { recursive: true })
    await mkdir(seedDir, { recursive: true })

    // Seed has a config.json with default content
    await writeFile(join(seedDir, 'config.json'), '{"default":true}')

    const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
    const manager = new ContainerManager(runtime, {
      stateBaseDir,
      secretsBaseDir,
      socketBaseDir,
    })

    const workload = createWorkloadSpec({
      volumes: {
        state: { target: '/state', readOnly: false, seed: seedDir },
      },
    })
    const poolId = createPoolId()
    const container = await manager.createContainer(workload, poolId)

    // Pre-populate the state dir (simulates container process creating defaults)
    await writeFile(join(manager.getStateDir(container.containerId), 'config.json'), '{"container":"default"}')
    await writeFile(join(manager.getStateDir(container.containerId), 'existing.txt'), 'tenant data')

    // Apply seed — should overwrite config.json but preserve existing.txt
    await manager.applySeed(container.containerId, workload)

    const files = await readdir(manager.getStateDir(container.containerId))
    expect(files).toContain('config.json')
    expect(files).toContain('existing.txt')

    // Seed's config.json should win
    const config = await readFile(join(manager.getStateDir(container.containerId), 'config.json'), 'utf-8')
    expect(JSON.parse(config)).toEqual({ default: true })

    await rm(baseDir, { recursive: true, force: true })
  })

  test('chowns seed files when workload has a user UID', async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const baseDir = await mkdtemp(join(tmpdir(), 'seed-test-'))
    const stateBaseDir = join(baseDir, 'state')
    const secretsBaseDir = join(baseDir, 'secrets')
    const socketBaseDir = join(baseDir, 'sockets')
    const seedDir = join(baseDir, 'seed')

    await mkdir(stateBaseDir, { recursive: true })
    await mkdir(secretsBaseDir, { recursive: true })
    await mkdir(socketBaseDir, { recursive: true })
    await mkdir(seedDir, { recursive: true })

    await writeFile(join(seedDir, 'app.conf'), 'setting=1')

    const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
    const manager = new ContainerManager(runtime, {
      stateBaseDir,
      secretsBaseDir,
      socketBaseDir,
    })

    const workload = createWorkloadSpec({
      user: 1000,
      volumes: {
        state: { target: '/state', readOnly: false, seed: seedDir },
      },
    })
    const poolId = createPoolId()
    const container = await manager.createContainer(workload, poolId)

    chownMock.mockClear()

    await manager.applySeed(container.containerId, workload)

    // chown should have been called for the seeded files/dirs
    expect(chownMock).toHaveBeenCalled()
    // All chown calls should use the workload UID
    for (const call of chownMock.mock.calls) {
      expect(call[1]).toBe(1000)
      expect(call[2]).toBe(1000)
    }

    await rm(baseDir, { recursive: true, force: true })
  })

  test('no-op when workload has no seed configured', async () => {
    const { mkdtemp, mkdir, readdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const baseDir = await mkdtemp(join(tmpdir(), 'seed-test-'))
    const stateBaseDir = join(baseDir, 'state')
    const secretsBaseDir = join(baseDir, 'secrets')
    const socketBaseDir = join(baseDir, 'sockets')

    await mkdir(stateBaseDir, { recursive: true })
    await mkdir(secretsBaseDir, { recursive: true })
    await mkdir(socketBaseDir, { recursive: true })

    const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
    const manager = new ContainerManager(runtime, {
      stateBaseDir,
      secretsBaseDir,
      socketBaseDir,
    })

    // No seed field on volumes
    const workload = createWorkloadSpec({
      volumes: {
        state: { target: '/state', readOnly: false },
      },
    })
    const poolId = createPoolId()
    const container = await manager.createContainer(workload, poolId)

    // Should not throw and state dir should remain empty
    await manager.applySeed(container.containerId, workload)

    const files = await readdir(manager.getStateDir(container.containerId))
    expect(files).toHaveLength(0)

    await rm(baseDir, { recursive: true, force: true })
  })

  test('copies nested seed directories recursively', async () => {
    const { mkdtemp, writeFile, mkdir, readdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const baseDir = await mkdtemp(join(tmpdir(), 'seed-test-'))
    const stateBaseDir = join(baseDir, 'state')
    const secretsBaseDir = join(baseDir, 'secrets')
    const socketBaseDir = join(baseDir, 'sockets')
    const seedDir = join(baseDir, 'seed')

    await mkdir(stateBaseDir, { recursive: true })
    await mkdir(secretsBaseDir, { recursive: true })
    await mkdir(socketBaseDir, { recursive: true })
    await mkdir(join(seedDir, 'workspace'), { recursive: true })

    await writeFile(join(seedDir, 'config.json'), '{}')
    await writeFile(join(seedDir, 'workspace', 'SOUL.md'), '# Soul')

    const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
    const manager = new ContainerManager(runtime, {
      stateBaseDir,
      secretsBaseDir,
      socketBaseDir,
    })

    const workload = createWorkloadSpec({
      volumes: {
        state: { target: '/state', readOnly: false, seed: seedDir },
      },
    })
    const poolId = createPoolId()
    const container = await manager.createContainer(workload, poolId)

    await manager.applySeed(container.containerId, workload)

    const stateDir = manager.getStateDir(container.containerId)
    const topFiles = await readdir(stateDir)
    expect(topFiles).toContain('config.json')
    expect(topFiles).toContain('workspace')

    const nestedFiles = await readdir(join(stateDir, 'workspace'))
    expect(nestedFiles).toContain('SOUL.md')

    await rm(baseDir, { recursive: true, force: true })
  })

  test('seeds multiple volumes independently', async () => {
    const { mkdtemp, writeFile, mkdir, readdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const baseDir = await mkdtemp(join(tmpdir(), 'seed-test-'))
    const stateBaseDir = join(baseDir, 'state')
    const secretsBaseDir = join(baseDir, 'secrets')
    const socketBaseDir = join(baseDir, 'sockets')
    const stateSeedDir = join(baseDir, 'state-seed')
    const secretsSeedDir = join(baseDir, 'secrets-seed')

    await mkdir(stateBaseDir, { recursive: true })
    await mkdir(secretsBaseDir, { recursive: true })
    await mkdir(socketBaseDir, { recursive: true })
    await mkdir(stateSeedDir, { recursive: true })
    await mkdir(secretsSeedDir, { recursive: true })

    await writeFile(join(stateSeedDir, 'state-file.txt'), 'state default')
    await writeFile(join(secretsSeedDir, 'secret-file.txt'), 'secret default')

    const runtime = createMockContainerRuntime() as unknown as ContainerRuntime
    const manager = new ContainerManager(runtime, {
      stateBaseDir,
      secretsBaseDir,
      socketBaseDir,
    })

    const workload = createWorkloadSpec({
      volumes: {
        state: { target: '/state', readOnly: false, seed: stateSeedDir },
        secrets: { target: '/secrets', readOnly: true, seed: secretsSeedDir },
      },
    })
    const poolId = createPoolId()
    const container = await manager.createContainer(workload, poolId)

    await manager.applySeed(container.containerId, workload)

    const stateFiles = await readdir(manager.getStateDir(container.containerId))
    expect(stateFiles).toContain('state-file.txt')

    const secretsFiles = await readdir(manager.getSecretsDir(container.containerId))
    expect(secretsFiles).toContain('secret-file.txt')

    await rm(baseDir, { recursive: true, force: true })
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
