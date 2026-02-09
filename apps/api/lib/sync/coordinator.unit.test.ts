/**
 * SyncCoordinator Unit Tests
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SyncId, type WorkloadSyncConfig, type WorkloadSyncPolicy } from '@boilerhouse/core'
import pino from 'pino'
import { createTestDb } from '../../test/db'
import {
  createMockRcloneExecutor,
  createPoolContainer,
  createS3SinkConfig,
  createTenantId,
  createWorkloadSyncMapping,
} from '../../test/fixtures'
import { SyncCoordinator } from './coordinator'
import type { RcloneSyncExecutor } from './rclone'
import { SyncStatusTracker } from './status'

const DEFAULT_POLICY: WorkloadSyncPolicy = {
  onClaim: true,
  onRelease: true,
  manual: true,
}

interface SyncConfigOverrides {
  sink?: WorkloadSyncConfig['sink']
  mappings?: WorkloadSyncConfig['mappings']
  policy?: Partial<WorkloadSyncPolicy>
}

function createSyncConfig(overrides?: SyncConfigOverrides): WorkloadSyncConfig {
  return {
    sink: overrides?.sink ?? createS3SinkConfig(),
    mappings: overrides?.mappings ?? [createWorkloadSyncMapping()],
    policy: {
      ...DEFAULT_POLICY,
      ...overrides?.policy,
    },
  }
}

describe('SyncCoordinator', () => {
  let executor: RcloneSyncExecutor
  let statusTracker: SyncStatusTracker
  let coordinator: SyncCoordinator

  beforeEach(() => {
    executor = createMockRcloneExecutor() as unknown as RcloneSyncExecutor
    const db = createTestDb()
    statusTracker = new SyncStatusTracker(db)
    coordinator = new SyncCoordinator(executor, statusTracker, pino({ level: 'silent' }), {
      verbose: false,
    })
  })

  /** Simulate a prior successful sync so hasSyncedBefore() returns true */
  function seedPriorSync(tenantId: ReturnType<typeof createTenantId>, container: ReturnType<typeof createPoolContainer>) {
    const syncId = SyncId(`workload-sync-${container.poolId}`)
    statusTracker.markSyncStarted(tenantId, syncId)
    statusTracker.markSyncCompleted(tenantId, syncId)
  }

  afterEach(async () => {
    await coordinator.shutdown()
  })

  describe('onClaim', () => {
    test('returns empty array when no sync config', async () => {
      const container = createPoolContainer()
      const results = await coordinator.onClaim(createTenantId(), container)
      expect(results).toHaveLength(0)
    })

    test('executes all mappings as download when onClaim is true', async () => {
      const syncConfig = createSyncConfig({
        mappings: [
          createWorkloadSyncMapping(),
          createWorkloadSyncMapping({ path: '/logs' }),
        ],
        policy: { onClaim: true, onRelease: false },
      })

      const tenantId = createTenantId()
      const container = createPoolContainer()
      seedPriorSync(tenantId, container)
      const results = await coordinator.onClaim(tenantId, container, syncConfig)

      // All mappings participate in claim (as download)
      expect(results).toHaveLength(2)
      expect(executor.sync).toHaveBeenCalledTimes(2)

      // Verify executor receives direction='download'
      const calls = (executor.sync as ReturnType<typeof import('bun:test').mock>).mock.calls
      expect(calls[0][1].direction).toBe('download')
      expect(calls[1][1].direction).toBe('download')
    })

    test('skips download for new tenant with no prior sync', async () => {
      const syncConfig = createSyncConfig({
        mappings: [createWorkloadSyncMapping()],
        policy: { onClaim: true },
      })

      const container = createPoolContainer()
      const results = await coordinator.onClaim(createTenantId(), container, syncConfig)

      // New tenant — no prior sync data, download should be skipped
      expect(results).toHaveLength(0)
      expect(executor.sync).not.toHaveBeenCalled()
    })

    test('skips sync when onClaim is false', async () => {
      const syncConfig = createSyncConfig({
        policy: { onClaim: false, onRelease: true },
      })

      const container = createPoolContainer()
      const results = await coordinator.onClaim(createTenantId(), container, syncConfig)

      expect(results).toHaveLength(0)
    })

    test('starts periodic sync when interval is set', async () => {
      const syncConfig = createSyncConfig({
        policy: { onClaim: true, interval: 60000 },
      })

      const tenantId = createTenantId()
      const container = createPoolContainer()
      seedPriorSync(tenantId, container)
      await coordinator.onClaim(tenantId, container, syncConfig)

      expect(coordinator.getStats().activeJobs).toBe(1)
    })
  })

  describe('onRelease', () => {
    test('returns empty array when no sync config', async () => {
      const container = createPoolContainer()
      const results = await coordinator.onRelease(createTenantId(), container)
      expect(results).toHaveLength(0)
    })

    test('executes all mappings as upload when onRelease is true', async () => {
      const syncConfig = createSyncConfig({
        mappings: [
          createWorkloadSyncMapping(),
          createWorkloadSyncMapping({ path: '/config' }),
        ],
        policy: { onClaim: false, onRelease: true },
      })

      const container = createPoolContainer()
      const results = await coordinator.onRelease(createTenantId(), container, syncConfig)

      // All mappings participate in release (as upload)
      expect(results).toHaveLength(2)

      // Verify executor receives direction='upload'
      const calls = (executor.sync as ReturnType<typeof import('bun:test').mock>).mock.calls
      expect(calls[0][1].direction).toBe('upload')
      expect(calls[1][1].direction).toBe('upload')
    })

    test('preserves tenant sync status after release (for hasSyncedBefore)', async () => {
      const tenantId = createTenantId()
      const syncConfig = createSyncConfig({
        policy: { onRelease: true },
      })

      const container = createPoolContainer()

      // Create some status
      const syncId = SyncId(`workload-sync-${container.poolId}`)
      statusTracker.markSyncStarted(tenantId, syncId)
      statusTracker.markSyncCompleted(tenantId, syncId)

      await coordinator.onRelease(tenantId, container, syncConfig)

      // Status should persist so hasSyncedBefore returns true on next claim
      const statuses = statusTracker.getStatusesForTenant(tenantId)
      expect(statuses).toHaveLength(1)
      expect(statusTracker.hasSyncedBefore(tenantId, syncId)).toBe(true)
    })

    test('stops periodic sync on release', async () => {
      const tenantId = createTenantId()
      const syncConfig = createSyncConfig({
        policy: { onClaim: true, onRelease: true, interval: 60000 },
      })

      const container = createPoolContainer()
      seedPriorSync(tenantId, container)

      // Start periodic sync via onClaim
      await coordinator.onClaim(tenantId, container, syncConfig)
      expect(coordinator.getStats().activeJobs).toBe(1)

      // Release should stop it
      await coordinator.onRelease(tenantId, container, syncConfig)
      expect(coordinator.getStats().activeJobs).toBe(0)
    })
  })

  describe('triggerSync', () => {
    test('returns empty array when no sync config', async () => {
      const container = createPoolContainer()
      const results = await coordinator.triggerSync(createTenantId(), container)
      expect(results).toHaveLength(0)
    })

    test('executes all mappings with specified direction', async () => {
      const syncConfig = createSyncConfig({
        mappings: [
          createWorkloadSyncMapping(),
          createWorkloadSyncMapping({ path: '/config' }),
        ],
        policy: { manual: true },
      })

      const container = createPoolContainer()
      const results = await coordinator.triggerSync(
        createTenantId(),
        container,
        syncConfig,
        'upload',
      )

      expect(results).toHaveLength(2)

      // Verify executor receives direction='upload'
      const calls = (executor.sync as ReturnType<typeof import('bun:test').mock>).mock.calls
      expect(calls[0][1].direction).toBe('upload')
      expect(calls[1][1].direction).toBe('upload')
    })

    test('returns empty when manual trigger not allowed', async () => {
      const syncConfig = createSyncConfig({
        policy: { manual: false },
      })

      const container = createPoolContainer()
      const results = await coordinator.triggerSync(createTenantId(), container, syncConfig)

      expect(results).toHaveLength(0)
    })
  })

  describe('getStats', () => {
    test('returns current stats', () => {
      const stats = coordinator.getStats()

      expect(stats.activeJobs).toBe(0)
      expect(stats.runningOperations).toBe(0)
      expect(stats.pendingOperations).toBe(0)
    })
  })

  describe('shutdown', () => {
    test('clears all periodic jobs', async () => {
      const syncConfig = createSyncConfig({
        policy: { onClaim: true, interval: 60000 },
      })

      const tenantId = createTenantId()
      const container = createPoolContainer()
      seedPriorSync(tenantId, container)
      await coordinator.onClaim(tenantId, container, syncConfig)

      // Should have an active job
      expect(coordinator.getStats().activeJobs).toBe(1)

      // Shutdown
      await coordinator.shutdown()

      // Jobs should be cleared
      expect(coordinator.getStats().activeJobs).toBe(0)
    })
  })
})
