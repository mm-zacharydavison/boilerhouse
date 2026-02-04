/**
 * SyncCoordinator Unit Tests
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createMockRcloneExecutor,
  createPoolContainer,
  createPoolId,
  createSyncMapping,
  createSyncSpec,
  createTenantId,
} from '../../test/fixtures'
import { SyncCoordinator } from './coordinator'
import type { RcloneSyncExecutor } from './rclone'
import { SyncRegistry } from './registry'
import { SyncStatusTracker } from './status'

describe('SyncCoordinator', () => {
  let registry: SyncRegistry
  let executor: RcloneSyncExecutor
  let statusTracker: SyncStatusTracker
  let coordinator: SyncCoordinator

  beforeEach(() => {
    registry = new SyncRegistry()
    executor = createMockRcloneExecutor() as unknown as RcloneSyncExecutor
    statusTracker = new SyncStatusTracker()
    coordinator = new SyncCoordinator(registry, executor, statusTracker, { verbose: false })
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  describe('onClaim', () => {
    test('executes download mappings when onClaim is true', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        mappings: [
          createSyncMapping({ direction: 'download' }),
          createSyncMapping({ direction: 'upload', containerPath: '/logs' }),
        ],
        policy: { onClaim: true, onRelease: false },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      const tenantId = createTenantId()
      const results = await coordinator.onClaim(tenantId, container)

      // Should only execute download mapping
      expect(results).toHaveLength(1)
      expect(executor.sync).toHaveBeenCalledTimes(1)
    })

    test('executes bidirectional mappings on claim', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        mappings: [createSyncMapping({ direction: 'bidirectional' })],
        policy: { onClaim: true },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      const results = await coordinator.onClaim(createTenantId(), container)

      expect(results).toHaveLength(1)
    })

    test('skips specs without onClaim', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        policy: { onClaim: false, onRelease: true },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      const results = await coordinator.onClaim(createTenantId(), container)

      expect(results).toHaveLength(0)
    })
  })

  describe('onRelease', () => {
    test('executes upload mappings when onRelease is true', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        mappings: [
          createSyncMapping({ direction: 'upload' }),
          createSyncMapping({ direction: 'download', containerPath: '/config' }),
        ],
        policy: { onClaim: false, onRelease: true },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      const results = await coordinator.onRelease(createTenantId(), container)

      // Should only execute upload mapping
      expect(results).toHaveLength(1)
    })

    test('clears tenant status after release', async () => {
      const poolId = createPoolId()
      const tenantId = createTenantId()
      const spec = createSyncSpec({
        poolId,
        policy: { onRelease: true },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })

      // Create some status
      statusTracker.markSyncStarted(tenantId, spec.id)
      statusTracker.markSyncCompleted(tenantId, spec.id)

      await coordinator.onRelease(tenantId, container)

      // Status should be cleared
      const statuses = statusTracker.getStatusesForTenant(tenantId)
      expect(statuses).toHaveLength(0)
    })
  })

  describe('triggerSync', () => {
    test('executes all mappings with direction=both', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        mappings: [
          createSyncMapping({ direction: 'upload' }),
          createSyncMapping({ direction: 'download', containerPath: '/config' }),
        ],
        policy: { allowManualTrigger: true },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      const results = await coordinator.triggerSync(createTenantId(), container, 'both')

      expect(results).toHaveLength(2)
    })

    test('executes only upload mappings with direction=upload', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        mappings: [
          createSyncMapping({ direction: 'upload' }),
          createSyncMapping({ direction: 'download', containerPath: '/config' }),
        ],
        policy: { allowManualTrigger: true },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      const results = await coordinator.triggerSync(createTenantId(), container, 'upload')

      expect(results).toHaveLength(1)
    })

    test('skips specs without allowManualTrigger', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        policy: { allowManualTrigger: false },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      const results = await coordinator.triggerSync(createTenantId(), container)

      expect(results).toHaveLength(0)
    })
  })

  describe('triggerSyncSpec', () => {
    test('executes sync for specific spec', async () => {
      const poolId = createPoolId()
      const spec1 = createSyncSpec({ poolId, policy: { allowManualTrigger: true } })
      const spec2 = createSyncSpec({ poolId, policy: { allowManualTrigger: true } })
      registry.register(spec1)
      registry.register(spec2)

      const container = createPoolContainer({ poolId })
      const results = await coordinator.triggerSyncSpec(createTenantId(), container, spec1.id)

      expect(results).toHaveLength(1)
      expect(executor.sync).toHaveBeenCalledTimes(1)
    })

    test('throws error for non-existent spec', async () => {
      const container = createPoolContainer()

      await expect(
        coordinator.triggerSyncSpec(createTenantId(), container, 'non-existent'),
      ).rejects.toThrow("SyncSpec 'non-existent' not found")
    })

    test('throws error if manual trigger not allowed', async () => {
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        policy: { allowManualTrigger: false },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })

      await expect(
        coordinator.triggerSyncSpec(createTenantId(), container, spec.id),
      ).rejects.toThrow('does not allow manual triggers')
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
      const poolId = createPoolId()
      const spec = createSyncSpec({
        poolId,
        policy: { onClaim: true, intervalMs: 60000 },
      })
      registry.register(spec)

      const container = createPoolContainer({ poolId })
      await coordinator.onClaim(createTenantId(), container)

      // Should have an active job
      expect(coordinator.getStats().activeJobs).toBe(1)

      // Shutdown
      await coordinator.shutdown()

      // Jobs should be cleared
      expect(coordinator.getStats().activeJobs).toBe(0)
    })
  })
})
