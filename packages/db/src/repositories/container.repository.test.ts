import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PoolContainer } from '@boilerhouse/core'
import { runMigrations } from '../migrations'
import { ContainerRepository } from './container.repository'

describe('ContainerRepository', () => {
  let db: Database
  let repo: ContainerRepository

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    repo = new ContainerRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  const createContainer = (overrides: Partial<PoolContainer> = {}): PoolContainer => ({
    containerId: 'test-container-1',
    tenantId: null,
    poolId: 'test-pool',
    socketPath: '/var/run/boilerhouse/test-container-1/app.sock',
    stateDir: '/var/lib/boilerhouse/states/test-container-1',
    secretsDir: '/var/lib/boilerhouse/secrets/test-container-1',
    lastActivity: new Date(),
    status: 'idle',
    lastTenantId: null,
    ...overrides,
  })

  test('save and findById', () => {
    const container = createContainer()
    repo.save(container)

    const found = repo.findById(container.containerId)
    expect(found).not.toBeNull()
    expect(found?.containerId).toBe(container.containerId)
    expect(found?.poolId).toBe(container.poolId)
    expect(found?.status).toBe('idle')
    expect(found?.tenantId).toBeNull()
  })

  test('save updates existing container', () => {
    const container = createContainer()
    repo.save(container)

    container.status = 'assigned'
    container.tenantId = 'tenant-123'
    repo.save(container)

    const found = repo.findById(container.containerId)
    expect(found?.status).toBe('assigned')
    expect(found?.tenantId).toBe('tenant-123')
  })

  test('updateTenant', () => {
    const container = createContainer()
    repo.save(container)

    repo.updateTenant(container.containerId, 'tenant-456', 'assigned')

    const found = repo.findById(container.containerId)
    expect(found?.tenantId).toBe('tenant-456')
    expect(found?.status).toBe('assigned')
  })

  test('updateLastTenantId', () => {
    const container = createContainer()
    repo.save(container)

    repo.updateLastTenantId(container.containerId, 'last-tenant-789')

    const found = repo.findById(container.containerId)
    expect(found?.lastTenantId).toBe('last-tenant-789')
  })

  test('delete', () => {
    const container = createContainer()
    repo.save(container)

    repo.delete(container.containerId)

    const found = repo.findById(container.containerId)
    expect(found).toBeNull()
  })

  test('findByTenantId', () => {
    const container = createContainer({ tenantId: 'tenant-abc' })
    repo.save(container)

    const found = repo.findByTenantId('tenant-abc')
    expect(found?.containerId).toBe(container.containerId)
  })

  test('findByPoolId', () => {
    const container1 = createContainer({ containerId: 'c1', poolId: 'pool-a' })
    const container2 = createContainer({ containerId: 'c2', poolId: 'pool-a' })
    const container3 = createContainer({ containerId: 'c3', poolId: 'pool-b' })
    repo.save(container1)
    repo.save(container2)
    repo.save(container3)

    const poolAContainers = repo.findByPoolId('pool-a')
    expect(poolAContainers.length).toBe(2)
    expect(poolAContainers.map((c) => c.containerId).sort()).toEqual(['c1', 'c2'])
  })

  test('findByStatus', () => {
    const idle = createContainer({ containerId: 'c1', status: 'idle' })
    const assigned = createContainer({ containerId: 'c2', status: 'assigned' })
    const stopping = createContainer({ containerId: 'c3', status: 'stopping' })
    repo.save(idle)
    repo.save(assigned)
    repo.save(stopping)

    const idleContainers = repo.findByStatus('idle')
    expect(idleContainers.length).toBe(1)
    expect(idleContainers[0].containerId).toBe('c1')
  })

  test('findAll', () => {
    repo.save(createContainer({ containerId: 'c1' }))
    repo.save(createContainer({ containerId: 'c2' }))
    repo.save(createContainer({ containerId: 'c3' }))

    const all = repo.findAll()
    expect(all.length).toBe(3)
  })

  test('getAllContainerIds', () => {
    repo.save(createContainer({ containerId: 'c1' }))
    repo.save(createContainer({ containerId: 'c2' }))

    const ids = repo.getAllContainerIds()
    expect(ids.sort()).toEqual(['c1', 'c2'])
  })

  test('deleteNotIn clears all when empty array', () => {
    repo.save(createContainer({ containerId: 'c1' }))
    repo.save(createContainer({ containerId: 'c2' }))

    const deleted = repo.deleteNotIn([])
    expect(deleted).toBe(2)
    expect(repo.findAll().length).toBe(0)
  })

  test('deleteNotIn keeps specified containers', () => {
    repo.save(createContainer({ containerId: 'c1' }))
    repo.save(createContainer({ containerId: 'c2' }))
    repo.save(createContainer({ containerId: 'c3' }))

    const deleted = repo.deleteNotIn(['c1', 'c3'])
    expect(deleted).toBe(1)
    expect(repo.getAllContainerIds().sort()).toEqual(['c1', 'c3'])
  })
})
