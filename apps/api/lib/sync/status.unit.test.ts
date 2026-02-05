/**
 * SyncStatusTracker Unit Tests
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { SyncStatusRepository } from '@boilerhouse/db'
import { createTestDb } from '../../test/db'
import { createSyncId, createTenantId } from '../../test/fixtures'
import { SyncStatusTracker } from './status'

describe('SyncStatusTracker', () => {
  let tracker: SyncStatusTracker

  beforeEach(() => {
    const db = createTestDb()
    const syncStatusRepo = new SyncStatusRepository(db)
    tracker = new SyncStatusTracker(syncStatusRepo)
  })

  describe('getStatus', () => {
    test('returns default status for new tenant+sync', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      const status = tracker.getStatus(tenantId, syncId)

      expect(status.tenantId).toBe(tenantId)
      expect(status.syncId).toBe(syncId)
      expect(status.state).toBe('idle')
      expect(status.pendingCount).toBe(0)
      expect(status.errors).toEqual([])
      expect(status.lastSyncAt).toBeUndefined()
    })
  })

  describe('markSyncStarted', () => {
    test('increments pending count and sets state to syncing', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      tracker.markSyncStarted(tenantId, syncId)

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.state).toBe('syncing')
      expect(status.pendingCount).toBe(1)
    })

    test('increments pending count for multiple syncs', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncStarted(tenantId, syncId)

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.pendingCount).toBe(2)
    })
  })

  describe('markSyncCompleted', () => {
    test('decrements pending count and sets lastSyncAt', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncCompleted(tenantId, syncId)

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.state).toBe('idle')
      expect(status.pendingCount).toBe(0)
      expect(status.lastSyncAt).toBeDefined()
    })

    test('keeps syncing state if more pending', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncCompleted(tenantId, syncId)

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.state).toBe('syncing')
      expect(status.pendingCount).toBe(1)
    })

    test('clears errors on successful completion', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncFailed(tenantId, syncId, 'error 1')
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncCompleted(tenantId, syncId)

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.errors).toEqual([])
    })
  })

  describe('markSyncFailed', () => {
    test('sets state to error and records error', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncFailed(tenantId, syncId, 'Connection failed')

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.state).toBe('error')
      expect(status.errors).toHaveLength(1)
      expect(status.errors[0].message).toBe('Connection failed')
    })

    test('records mapping in error', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      tracker.markSyncStarted(tenantId, syncId)
      tracker.markSyncFailed(tenantId, syncId, 'error', '/data/logs')

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.errors[0].mapping).toBe('/data/logs')
    })

    test('limits error count to maxErrors', () => {
      const tenantId = createTenantId()
      const syncId = createSyncId()
      for (let i = 0; i < 15; i++) {
        tracker.markSyncStarted(tenantId, syncId)
        tracker.markSyncFailed(tenantId, syncId, `error ${i}`)
      }

      const status = tracker.getStatus(tenantId, syncId)
      expect(status.errors.length).toBeLessThanOrEqual(10)
    })
  })

  describe('getStatusesForTenant', () => {
    test('returns all statuses for a tenant', () => {
      const tenantId = createTenantId()
      const otherTenantId = createTenantId()
      tracker.markSyncStarted(tenantId, createSyncId())
      tracker.markSyncStarted(tenantId, createSyncId())
      tracker.markSyncStarted(otherTenantId, createSyncId())

      const statuses = tracker.getStatusesForTenant(tenantId)
      expect(statuses).toHaveLength(2)
    })
  })

  describe('clearTenant', () => {
    test('clears all statuses for a tenant', () => {
      const tenantId = createTenantId()
      const otherTenantId = createTenantId()
      tracker.markSyncStarted(tenantId, createSyncId())
      tracker.markSyncStarted(tenantId, createSyncId())
      tracker.markSyncStarted(otherTenantId, createSyncId())

      tracker.clearTenant(tenantId)

      expect(tracker.getStatusesForTenant(tenantId)).toHaveLength(0)
      expect(tracker.getStatusesForTenant(otherTenantId)).toHaveLength(1)
    })
  })

  describe('getPendingSyncs', () => {
    test('returns all pending syncs', () => {
      const tenantId1 = createTenantId()
      const tenantId2 = createTenantId()
      const syncId1 = createSyncId()
      const syncId2 = createSyncId()
      tracker.markSyncStarted(tenantId1, syncId1)
      tracker.markSyncStarted(tenantId2, syncId2)
      tracker.markSyncCompleted(tenantId2, syncId2)

      const pending = tracker.getPendingSyncs()
      expect(pending).toHaveLength(1)
      expect(pending[0].tenantId).toBe(tenantId1)
    })
  })

  describe('getErrorSyncs', () => {
    test('returns all syncs in error state', () => {
      const tenantId1 = createTenantId()
      const tenantId2 = createTenantId()
      const syncId1 = createSyncId()
      const syncId2 = createSyncId()
      tracker.markSyncStarted(tenantId1, syncId1)
      tracker.markSyncFailed(tenantId1, syncId1, 'error')
      tracker.markSyncStarted(tenantId2, syncId2)
      tracker.markSyncCompleted(tenantId2, syncId2)

      const errored = tracker.getErrorSyncs()
      expect(errored).toHaveLength(1)
      expect(errored[0].tenantId).toBe(tenantId1)
    })
  })
})
