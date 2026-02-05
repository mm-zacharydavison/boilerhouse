import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMigrations } from '../migrations'
import { SyncStatusRepository } from './sync-status.repository'

describe('SyncStatusRepository', () => {
  let db: Database
  let repo: SyncStatusRepository

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    repo = new SyncStatusRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  test('save and findByTenantAndSync', () => {
    const now = new Date()
    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-1',
      lastSyncAt: now,
      pendingCount: 2,
      state: 'syncing',
      updatedAt: now,
    })

    const found = repo.findByTenantAndSync('tenant-1', 'sync-1')
    expect(found).not.toBeNull()
    expect(found?.tenantId).toBe('tenant-1')
    expect(found?.syncId).toBe('sync-1')
    expect(found?.pendingCount).toBe(2)
    expect(found?.state).toBe('syncing')
  })

  test('save updates existing status', () => {
    const now = new Date()
    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-1',
      lastSyncAt: now,
      pendingCount: 1,
      state: 'syncing',
      updatedAt: now,
    })

    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-1',
      lastSyncAt: now,
      pendingCount: 0,
      state: 'idle',
      updatedAt: now,
    })

    const found = repo.findByTenantAndSync('tenant-1', 'sync-1')
    expect(found?.pendingCount).toBe(0)
    expect(found?.state).toBe('idle')
  })

  test('addError and findErrors', () => {
    repo.addError('tenant-1', 'sync-1', 'Connection failed', '/data/files')

    const errors = repo.findErrors('tenant-1', 'sync-1')
    expect(errors.length).toBe(1)
    expect(errors[0].message).toBe('Connection failed')
    expect(errors[0].mapping).toBe('/data/files')
  })

  test('addError trims old errors', () => {
    const maxErrors = 10
    const repoWithLimit = new SyncStatusRepository(db, maxErrors)

    for (let i = 0; i < 15; i++) {
      repoWithLimit.addError('tenant-1', 'sync-1', `Error ${i}`)
    }

    const errors = repoWithLimit.findErrors('tenant-1', 'sync-1')
    expect(errors.length).toBe(maxErrors)
    // Should keep the most recent errors (findErrors returns DESC order, so index 0 is newest)
    expect(errors[0].message).toBe('Error 14')
    expect(errors[9].message).toBe('Error 5')
  })

  test('clearErrors', () => {
    repo.addError('tenant-1', 'sync-1', 'Error 1')
    repo.addError('tenant-1', 'sync-1', 'Error 2')

    repo.clearErrors('tenant-1', 'sync-1')

    const errors = repo.findErrors('tenant-1', 'sync-1')
    expect(errors.length).toBe(0)
  })

  test('findByTenant', () => {
    const now = new Date()
    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-1',
      lastSyncAt: null,
      pendingCount: 0,
      state: 'idle',
      updatedAt: now,
    })
    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-2',
      lastSyncAt: null,
      pendingCount: 0,
      state: 'idle',
      updatedAt: now,
    })
    repo.save({
      tenantId: 'tenant-2',
      syncId: 'sync-1',
      lastSyncAt: null,
      pendingCount: 0,
      state: 'idle',
      updatedAt: now,
    })

    const tenant1Statuses = repo.findByTenant('tenant-1')
    expect(tenant1Statuses.length).toBe(2)
  })

  test('deleteByTenant', () => {
    const now = new Date()
    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-1',
      lastSyncAt: null,
      pendingCount: 0,
      state: 'idle',
      updatedAt: now,
    })
    repo.addError('tenant-1', 'sync-1', 'Error')

    repo.deleteByTenant('tenant-1')

    expect(repo.findByTenant('tenant-1').length).toBe(0)
    expect(repo.findErrors('tenant-1', 'sync-1').length).toBe(0)
  })

  test('findInErrorState', () => {
    const now = new Date()
    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-1',
      lastSyncAt: null,
      pendingCount: 0,
      state: 'idle',
      updatedAt: now,
    })
    repo.save({
      tenantId: 'tenant-2',
      syncId: 'sync-1',
      lastSyncAt: null,
      pendingCount: 0,
      state: 'error',
      updatedAt: now,
    })

    const errorStatuses = repo.findInErrorState()
    expect(errorStatuses.length).toBe(1)
    expect(errorStatuses[0].tenantId).toBe('tenant-2')
  })

  test('findWithPending', () => {
    const now = new Date()
    repo.save({
      tenantId: 'tenant-1',
      syncId: 'sync-1',
      lastSyncAt: null,
      pendingCount: 0,
      state: 'idle',
      updatedAt: now,
    })
    repo.save({
      tenantId: 'tenant-2',
      syncId: 'sync-1',
      lastSyncAt: null,
      pendingCount: 3,
      state: 'syncing',
      updatedAt: now,
    })

    const pendingStatuses = repo.findWithPending()
    expect(pendingStatuses.length).toBe(1)
    expect(pendingStatuses[0].tenantId).toBe('tenant-2')
  })
})
