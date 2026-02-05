/**
 * SyncCoordinator Unit Tests
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { WorkloadSyncConfig, WorkloadSyncPolicy } from '@boilerhouse/core'
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
    statusTracker = new SyncStatusTracker()
    coordinator = new SyncCoordinator(executor, statusTracker, { verbose: false })
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  describe('onClaim', () => {
    test('returns empty array when no sync config', async () => {
      const container = createPoolContainer()
      const results = await coordinator.onClaim(createTenantId(), container)
      expect(results).toHaveLength(0)
    })

    test('executes download mappings when onClaim is true', async () => {
      const syncConfig = createSyncConfig({
        mappings: [
          createWorkloadSyncMapping({ direction: 'download' }),
          createWorkloadSyncMapping({ direction: 'upload', path: '/logs' }),
        ],
        policy: { onClaim: true, onRelease: false },
      })

      const container = createPoolContainer()
      const results = await coordinator.onClaim(createTenantId(), container, syncConfig)

      // Should only execute download mapping
      expect(results).toHaveLength(1)
      expect(executor.sync).toHaveBeenCalledTimes(1)
    })

    test('executes bidirectional mappings on claim', async () => {
      const syncConfig = createSyncConfig({
        mappings: [createWorkloadSyncMapping({ direction: 'bidirectional' })],
        policy: { onClaim: true },
      })

      const container = createPoolContainer()
      const results = await coordinator.onClaim(createTenantId(), container, syncConfig)

      expect(results).toHaveLength(1)
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

      const container = createPoolContainer()
      await coordinator.onClaim(createTenantId(), container, syncConfig)

      expect(coordinator.getStats().activeJobs).toBe(1)
    })
  })

  describe('onRelease', () => {
    test('returns empty array when no sync config', async () => {
      const container = createPoolContainer()
      const results = await coordinator.onRelease(createTenantId(), container)
      expect(results).toHaveLength(0)
    })

    test('executes upload mappings when onRelease is true', async () => {
      const syncConfig = createSyncConfig({
        mappings: [
          createWorkloadSyncMapping({ direction: 'upload' }),
          createWorkloadSyncMapping({ direction: 'download', path: '/config' }),
        ],
        policy: { onClaim: false, onRelease: true },
      })

      const container = createPoolContainer()
      const results = await coordinator.onRelease(createTenantId(), container, syncConfig)

      // Should only execute upload mapping
      expect(results).toHaveLength(1)
    })

    test('clears tenant status after release', async () => {
      const tenantId = createTenantId()
      const syncConfig = createSyncConfig({
        policy: { onRelease: true },
      })

      const container = createPoolContainer()

      // Create some status
      const syncId = `workload-sync-${container.poolId}`
      statusTracker.markSyncStarted(tenantId, syncId)
      statusTracker.markSyncCompleted(tenantId, syncId)

      await coordinator.onRelease(tenantId, container, syncConfig)

      // Status should be cleared
      const statuses = statusTracker.getStatusesForTenant(tenantId)
      expect(statuses).toHaveLength(0)
    })

    test('stops periodic sync on release', async () => {
      const tenantId = createTenantId()
      const syncConfig = createSyncConfig({
        policy: { onClaim: true, onRelease: true, interval: 60000 },
      })

      const container = createPoolContainer()

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

    test('executes all mappings with direction=both', async () => {
      const syncConfig = createSyncConfig({
        mappings: [
          createWorkloadSyncMapping({ direction: 'upload' }),
          createWorkloadSyncMapping({ direction: 'download', path: '/config' }),
        ],
        policy: { manual: true },
      })

      const container = createPoolContainer()
      const results = await coordinator.triggerSync(createTenantId(), container, syncConfig, 'both')

      expect(results).toHaveLength(2)
    })

    test('executes only upload mappings with direction=upload', async () => {
      const syncConfig = createSyncConfig({
        mappings: [
          createWorkloadSyncMapping({ direction: 'upload' }),
          createWorkloadSyncMapping({ direction: 'download', path: '/config' }),
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

      expect(results).toHaveLength(1)
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

      const container = createPoolContainer()
      await coordinator.onClaim(createTenantId(), container, syncConfig)

      // Should have an active job
      expect(coordinator.getStats().activeJobs).toBe(1)

      // Shutdown
      await coordinator.shutdown()

      // Jobs should be cleared
      expect(coordinator.getStats().activeJobs).toBe(0)
    })
  })
})
