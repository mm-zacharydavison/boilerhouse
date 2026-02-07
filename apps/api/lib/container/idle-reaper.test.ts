/**
 * Idle Reaper Tests
 *
 * Tests for filesystem-based TTL expiry of claimed containers via mtime polling.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ContainerId,
  type ContainerRuntime,
  type PoolId,
  TenantId,
  WorkloadId,
} from '@boilerhouse/core'
import { createTestDatabase, schema } from '@boilerhouse/db'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { IdleReaper } from './idle-reaper'
import { ContainerManager } from './manager'
import { ContainerPool } from './pool'

const silentLogger = pino({ level: 'silent' })

function createMockRuntime(): ContainerRuntime {
  return {
    name: 'mock',
    createContainer: mock(async (spec) => ({
      containerId: spec.name,
      runtimeId: `rt-${spec.name}`,
      status: 'running' as const,
      image: spec.image,
      created: new Date(),
      labels: spec.labels,
    })),
    stopContainer: mock(async () => {}),
    removeContainer: mock(async () => {}),
    destroyContainer: mock(async () => {}),
    restartContainer: mock(async () => {}),
    getContainer: mock(async (id) => ({
      containerId: id,
      runtimeId: `rt-${id}`,
      status: 'running' as const,
      image: 'test:latest',
      created: new Date(),
      labels: {},
    })),
    isHealthy: mock(async () => true),
    listContainers: mock(async () => []),
    exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  } as unknown as ContainerRuntime
}

type ExpiryFn = (containerId: ContainerId, tenantId: TenantId, poolId: PoolId) => Promise<void>

/** Short poll interval for tests */
const TEST_POLL_MS = 50

const TEST_DIR = join(import.meta.dir, '..', '..', '..', '..', '.test-idle-reaper')

function setupTest() {
  const db = createTestDatabase()
  const runtime = createMockRuntime()
  const stateBaseDir = join(TEST_DIR, 'states')
  const manager = new ContainerManager(runtime, {
    stateBaseDir,
    secretsBaseDir: join(TEST_DIR, 'secrets'),
    socketBaseDir: join(TEST_DIR, 'sockets'),
  })

  // Ensure test directories exist
  mkdirSync(stateBaseDir, { recursive: true })

  return { db, runtime, manager, stateBaseDir }
}

function cleanup() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // Ignore
  }
}

const WORKLOAD_FIXTURE = {
  id: WorkloadId('workload-1'),
  name: 'Test',
  image: 'test:latest',
  volumes: {
    state: { target: '/state', readOnly: false },
    secrets: { target: '/secrets', readOnly: true },
    comm: { target: '/comm', readOnly: false },
  },
  environment: {},
  healthcheck: { test: ['true'], interval: 30000, timeout: 5000, retries: 3 },
}

describe('IdleReaper', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(cleanup)

  test('watch starts monitoring and unwatch stops it', () => {
    const { db, stateBaseDir } = setupTest()
    const containerId = 'test-container-1' as ContainerId
    const tenantId = 'tenant-1' as TenantId
    const poolId = 'pool-1' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    expect(reaper.isWatching(containerId)).toBe(false)
    expect(reaper.activeWatchCount).toBe(0)

    reaper.watch(containerId, tenantId, poolId, stateDir, 60000)
    expect(reaper.isWatching(containerId)).toBe(true)
    expect(reaper.activeWatchCount).toBe(1)

    reaper.unwatch(containerId)
    expect(reaper.isWatching(containerId)).toBe(false)
    expect(reaper.activeWatchCount).toBe(0)

    reaper.shutdown()
  })

  test('unwatch is a no-op for unwatched container', () => {
    const { db } = setupTest()
    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    // Should not throw
    reaper.unwatch('nonexistent' as ContainerId)
    expect(reaper.activeWatchCount).toBe(0)

    reaper.shutdown()
  })

  test('expiry fires after TTL with no writes', async () => {
    const { db, stateBaseDir } = setupTest()
    const containerId = 'test-container-expire' as ContainerId
    const tenantId = 'tenant-expire' as TenantId
    const poolId = 'pool-expire' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    // TTL of 100ms — will expire after a couple poll cycles
    reaper.watch(containerId, tenantId, poolId, stateDir, 100)

    // Wait for poll to detect expiry (TTL + a few poll cycles)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(onExpiry).toHaveBeenCalledTimes(1)
    expect(onExpiry.mock.calls[0][0]).toBe(containerId)
    expect(onExpiry.mock.calls[0][1]).toBe(tenantId)
    expect(onExpiry.mock.calls[0][2]).toBe(poolId)

    // Watch should be cleaned up after expiry
    expect(reaper.isWatching(containerId)).toBe(false)

    reaper.shutdown()
  })

  test('file write resets the expiry timer', async () => {
    const { db, stateBaseDir } = setupTest()
    const containerId = 'test-container-reset' as ContainerId
    const tenantId = 'tenant-reset' as TenantId
    const poolId = 'pool-reset' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    // TTL of 200ms
    reaper.watch(containerId, tenantId, poolId, stateDir, 200)

    // Write at ~100ms to reset the TTL
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(join(stateDir, 'activity.txt'), 'data')

    // At ~250ms the original TTL would have expired, but the write reset it
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(onExpiry).toHaveBeenCalledTimes(0)

    // Wait for the reset timer to expire (~200ms from the write at 100ms = ~300ms total)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onExpiry).toHaveBeenCalledTimes(1)

    reaper.shutdown()
  })

  test('nested file write also resets the timer', async () => {
    const { db, stateBaseDir } = setupTest()
    const containerId = 'test-container-nested' as ContainerId
    const tenantId = 'tenant-nested' as TenantId
    const poolId = 'pool-nested' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(join(stateDir, 'subdir', 'deep'), { recursive: true })

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    reaper.watch(containerId, tenantId, poolId, stateDir, 200)

    // Write a nested file at ~100ms
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(join(stateDir, 'subdir', 'deep', 'data.json'), '{}')

    // Should not have expired at ~250ms
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(onExpiry).toHaveBeenCalledTimes(0)

    // Should expire ~200ms after the nested write
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onExpiry).toHaveBeenCalledTimes(1)

    reaper.shutdown()
  })

  test('explicit unwatch prevents expiry', async () => {
    const { db, stateBaseDir } = setupTest()
    const containerId = 'test-container-unwatch' as ContainerId
    const tenantId = 'tenant-unwatch' as TenantId
    const poolId = 'pool-unwatch' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    reaper.watch(containerId, tenantId, poolId, stateDir, 100)

    // Unwatch before expiry
    await new Promise((resolve) => setTimeout(resolve, 50))
    reaper.unwatch(containerId)

    // Wait past what would have been the expiry
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onExpiry).toHaveBeenCalledTimes(0)

    reaper.shutdown()
  })

  test('shutdown clears all watches', () => {
    const { db, stateBaseDir } = setupTest()
    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    for (let i = 0; i < 3; i++) {
      const containerId = `container-${i}` as ContainerId
      const stateDir = join(stateBaseDir, containerId)
      mkdirSync(stateDir, { recursive: true })
      reaper.watch(containerId, `tenant-${i}` as TenantId, 'pool-1' as PoolId, stateDir, 60000)
    }

    expect(reaper.activeWatchCount).toBe(3)

    reaper.shutdown()
    expect(reaper.activeWatchCount).toBe(0)
  })

  test('watch replaces existing watch for the same container', () => {
    const { db, stateBaseDir } = setupTest()
    const containerId = 'test-container-replace' as ContainerId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    reaper.watch(containerId, 'tenant-1' as TenantId, 'pool-1' as PoolId, stateDir, 60000)
    expect(reaper.activeWatchCount).toBe(1)

    // Re-watch with different params — should replace, not duplicate
    reaper.watch(containerId, 'tenant-2' as TenantId, 'pool-1' as PoolId, stateDir, 30000)
    expect(reaper.activeWatchCount).toBe(1)

    reaper.shutdown()
  })

  test('poll updates lastActivity in DB on detected write', async () => {
    const { db, stateBaseDir } = setupTest()
    const containerId = 'test-container-db' as ContainerId
    const tenantId = 'tenant-db' as TenantId
    const poolId = 'pool-db' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    // Insert a container row so the DB update has something to update
    db.insert(schema.containers)
      .values({
        containerId,
        poolId,
        status: 'claimed',
        tenantId,
        lastActivity: new Date(0),
        createdAt: new Date(),
      })
      .run()

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    reaper.watch(containerId, tenantId, poolId, stateDir, 5000)

    // Write a file — the next poll cycle should detect mtime change
    await new Promise((resolve) => setTimeout(resolve, 60))
    writeFileSync(join(stateDir, 'data.txt'), 'hello')

    // Wait for poll + debounced DB update (setTimeout(0) + next tick)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Check that lastActivity was updated in DB
    const row = db
      .select({ lastActivity: schema.containers.lastActivity })
      .from(schema.containers)
      .where(eq(schema.containers.containerId, containerId))
      .get()

    expect(row).toBeTruthy()
    if (row) {
      expect(row.lastActivity.getTime()).toBeGreaterThan(Date.now() - 5000)
    }

    reaper.shutdown()
  })

  test('restoreFromDb starts watches for claimed containers', async () => {
    const { db, manager, stateBaseDir } = setupTest()
    const containerId = 'restore-container' as ContainerId
    const tenantId = 'restore-tenant' as TenantId
    const poolId = 'restore-pool' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    // Insert pool and container into DB
    db.insert(schema.pools)
      .values({
        poolId,
        workloadId: WorkloadId('workload-1'),
        minIdle: 1,
        maxSize: 5,
        idleTimeoutMs: 300000,
        evictionIntervalMs: 30000,
        acquireTimeoutMs: 30000,

        fileIdleTtl: 60000,
      })
      .run()

    db.insert(schema.containers)
      .values({
        containerId,
        poolId,
        status: 'claimed',
        tenantId,
        lastActivity: new Date(),
        createdAt: new Date(),
      })
      .run()

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    const runtime = createMockRuntime()
    const pool = new ContainerPool(
      new ContainerManager(runtime, {
        stateBaseDir,
        secretsBaseDir: join(TEST_DIR, 'secrets'),
        socketBaseDir: join(TEST_DIR, 'sockets'),
      }),
      { workload: WORKLOAD_FIXTURE, poolId, minIdle: 0, maxSize: 5, fileIdleTtl: 60000 },
      db,
      silentLogger,
    )

    const pools = new Map<PoolId, ContainerPool>([[poolId, pool]])

    await reaper.restoreFromDb(pools, manager)

    // Should have started a watch for the claimed container
    expect(reaper.isWatching(containerId)).toBe(true)

    reaper.shutdown()
    pool.stop()
  })

  test('restoreFromDb releases containers idle through restart', async () => {
    const { db, manager, stateBaseDir } = setupTest()
    const containerId = 'expired-container' as ContainerId
    const tenantId = 'expired-tenant' as TenantId
    const poolId = 'expired-pool' as PoolId
    const stateDir = join(stateBaseDir, containerId)
    mkdirSync(stateDir, { recursive: true })

    db.insert(schema.pools)
      .values({
        poolId,
        workloadId: WorkloadId('workload-1'),
        minIdle: 1,
        maxSize: 5,
        idleTimeoutMs: 300000,
        evictionIntervalMs: 30000,
        acquireTimeoutMs: 30000,

        fileIdleTtl: 1, // 1ms TTL — effectively always expired
      })
      .run()

    db.insert(schema.containers)
      .values({
        containerId,
        poolId,
        status: 'claimed',
        tenantId,
        lastActivity: new Date(Date.now() - 60000),
        createdAt: new Date(),
      })
      .run()

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    const runtime = createMockRuntime()
    const pool = new ContainerPool(
      new ContainerManager(runtime, {
        stateBaseDir,
        secretsBaseDir: join(TEST_DIR, 'secrets'),
        socketBaseDir: join(TEST_DIR, 'sockets'),
      }),
      { workload: WORKLOAD_FIXTURE, poolId, minIdle: 0, maxSize: 5, fileIdleTtl: 1 },
      db,
      silentLogger,
    )

    const pools = new Map<PoolId, ContainerPool>([[poolId, pool]])

    // Small delay to ensure mtime is stale relative to 1ms TTL
    await new Promise((resolve) => setTimeout(resolve, 10))

    await reaper.restoreFromDb(pools, manager)

    // Give async onExpiry a moment to be called
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(onExpiry).toHaveBeenCalledTimes(1)
    expect(onExpiry.mock.calls[0][0]).toBe(containerId)
    expect(onExpiry.mock.calls[0][1]).toBe(tenantId)
    expect(onExpiry.mock.calls[0][2]).toBe(poolId)

    reaper.shutdown()
    pool.stop()
  })

  test('restoreFromDb skips pools without fileIdleTtl', async () => {
    const { db, manager, stateBaseDir } = setupTest()
    const containerId = 'no-ttl-container' as ContainerId
    const poolId = 'no-ttl-pool' as PoolId

    db.insert(schema.pools)
      .values({
        poolId,
        workloadId: WorkloadId('workload-1'),
        minIdle: 1,
        maxSize: 5,
        idleTimeoutMs: 300000,
        evictionIntervalMs: 30000,
        acquireTimeoutMs: 30000,
      })
      .run()

    db.insert(schema.containers)
      .values({
        containerId,
        poolId,
        status: 'claimed',
        tenantId: TenantId('some-tenant'),
        lastActivity: new Date(),
        createdAt: new Date(),
      })
      .run()

    const onExpiry = mock<ExpiryFn>(async () => {})
    const reaper = new IdleReaper({
      db,
      onExpiry,
      pollIntervalMs: TEST_POLL_MS,
      logger: silentLogger,
    })

    const runtime = createMockRuntime()
    const pool = new ContainerPool(
      new ContainerManager(runtime, {
        stateBaseDir,
        secretsBaseDir: join(TEST_DIR, 'secrets'),
        socketBaseDir: join(TEST_DIR, 'sockets'),
      }),
      { workload: WORKLOAD_FIXTURE, poolId, minIdle: 0, maxSize: 5 },
      db,
      silentLogger,
    )

    const pools = new Map<PoolId, ContainerPool>([[poolId, pool]])

    await reaper.restoreFromDb(pools, manager)

    // Should NOT have started any watches
    expect(reaper.activeWatchCount).toBe(0)

    reaper.shutdown()
    pool.stop()
  })
})
