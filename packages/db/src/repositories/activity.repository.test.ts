import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMigrations } from '../migrations'
import { ActivityRepository } from './activity.repository'

describe('ActivityRepository', () => {
  let db: Database
  let repo: ActivityRepository

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    repo = new ActivityRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  test('save and findRecent', () => {
    repo.save({
      eventType: 'container.created',
      poolId: 'pool-1',
      containerId: 'container-1',
      tenantId: null,
      message: 'Container created',
      metadata: null,
      timestamp: new Date(),
    })

    const events = repo.findRecent()
    expect(events.length).toBe(1)
    expect(events[0].eventType).toBe('container.created')
    expect(events[0].poolId).toBe('pool-1')
  })

  test('save with metadata', () => {
    repo.save({
      eventType: 'sync.completed',
      poolId: null,
      containerId: null,
      tenantId: 'tenant-1',
      message: 'Sync completed',
      metadata: { bytesTransferred: 1024 },
      timestamp: new Date(),
    })

    const events = repo.findRecent()
    expect(events[0].metadata).toEqual({ bytesTransferred: 1024 })
  })

  test('findByType', () => {
    repo.save({
      eventType: 'container.created',
      poolId: 'pool-1',
      containerId: 'c1',
      tenantId: null,
      message: 'Created',
      metadata: null,
      timestamp: new Date(),
    })
    repo.save({
      eventType: 'container.destroyed',
      poolId: 'pool-1',
      containerId: 'c2',
      tenantId: null,
      message: 'Destroyed',
      metadata: null,
      timestamp: new Date(),
    })

    const createdEvents = repo.findByType('container.created')
    expect(createdEvents.length).toBe(1)
    expect(createdEvents[0].containerId).toBe('c1')
  })

  test('findByTenant', () => {
    repo.save({
      eventType: 'container.claimed',
      poolId: 'pool-1',
      containerId: 'c1',
      tenantId: 'tenant-1',
      message: 'Claimed',
      metadata: null,
      timestamp: new Date(),
    })
    repo.save({
      eventType: 'container.claimed',
      poolId: 'pool-1',
      containerId: 'c2',
      tenantId: 'tenant-2',
      message: 'Claimed',
      metadata: null,
      timestamp: new Date(),
    })

    const tenant1Events = repo.findByTenant('tenant-1')
    expect(tenant1Events.length).toBe(1)
    expect(tenant1Events[0].containerId).toBe('c1')
  })

  test('findByPool', () => {
    repo.save({
      eventType: 'container.created',
      poolId: 'pool-a',
      containerId: 'c1',
      tenantId: null,
      message: 'Created',
      metadata: null,
      timestamp: new Date(),
    })
    repo.save({
      eventType: 'container.created',
      poolId: 'pool-b',
      containerId: 'c2',
      tenantId: null,
      message: 'Created',
      metadata: null,
      timestamp: new Date(),
    })

    const poolAEvents = repo.findByPool('pool-a')
    expect(poolAEvents.length).toBe(1)
    expect(poolAEvents[0].containerId).toBe('c1')
  })

  test('findByContainer', () => {
    repo.save({
      eventType: 'container.created',
      poolId: 'pool-1',
      containerId: 'container-xyz',
      tenantId: null,
      message: 'Created',
      metadata: null,
      timestamp: new Date(),
    })
    repo.save({
      eventType: 'container.claimed',
      poolId: 'pool-1',
      containerId: 'container-xyz',
      tenantId: 'tenant-1',
      message: 'Claimed',
      metadata: null,
      timestamp: new Date(),
    })

    const containerEvents = repo.findByContainer('container-xyz')
    expect(containerEvents.length).toBe(2)
  })

  test('trim keeps maxEvents', () => {
    const maxEvents = 5
    const repoWithLimit = new ActivityRepository(db, maxEvents)

    for (let i = 0; i < 10; i++) {
      repoWithLimit.save({
        eventType: 'test.event',
        poolId: null,
        containerId: null,
        tenantId: null,
        message: `Event ${i}`,
        metadata: null,
        timestamp: new Date(),
      })
    }

    repoWithLimit.trim()

    expect(repoWithLimit.count()).toBe(maxEvents)
  })

  test('count', () => {
    repo.save({
      eventType: 'test.event',
      poolId: null,
      containerId: null,
      tenantId: null,
      message: 'Event 1',
      metadata: null,
      timestamp: new Date(),
    })
    repo.save({
      eventType: 'test.event',
      poolId: null,
      containerId: null,
      tenantId: null,
      message: 'Event 2',
      metadata: null,
      timestamp: new Date(),
    })

    expect(repo.count()).toBe(2)
  })

  test('clear', () => {
    repo.save({
      eventType: 'test.event',
      poolId: null,
      containerId: null,
      tenantId: null,
      message: 'Event',
      metadata: null,
      timestamp: new Date(),
    })

    repo.clear()

    expect(repo.count()).toBe(0)
  })

  test('findRecent respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      repo.save({
        eventType: 'test.event',
        poolId: null,
        containerId: null,
        tenantId: null,
        message: `Event ${i}`,
        metadata: null,
        timestamp: new Date(Date.now() + i * 1000), // Different timestamps
      })
    }

    const page1 = repo.findRecent(3, 0)
    expect(page1.length).toBe(3)

    const page2 = repo.findRecent(3, 3)
    expect(page2.length).toBe(3)

    // Make sure we get different events
    expect(page1[0].id).not.toBe(page2[0].id)
  })
})
