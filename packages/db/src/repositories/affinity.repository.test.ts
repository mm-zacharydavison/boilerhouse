import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMigrations } from '../migrations'
import { AffinityRepository } from './affinity.repository'
import { ContainerRepository } from './container.repository'

describe('AffinityRepository', () => {
  let db: Database
  let containerRepo: ContainerRepository
  let repo: AffinityRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    runMigrations(db)
    containerRepo = new ContainerRepository(db)
    repo = new AffinityRepository(db)

    // Create a container for foreign key references
    containerRepo.save({
      containerId: 'container-1',
      tenantId: null,
      poolId: 'pool-1',
      socketPath: '/var/run/app.sock',
      stateDir: '/var/lib/state',
      secretsDir: '/var/lib/secrets',
      lastActivity: new Date(),
      status: 'idle',
      lastTenantId: null,
    })
    containerRepo.save({
      containerId: 'container-2',
      tenantId: null,
      poolId: 'pool-1',
      socketPath: '/var/run/app2.sock',
      stateDir: '/var/lib/state2',
      secretsDir: '/var/lib/secrets2',
      lastActivity: new Date(),
      status: 'idle',
      lastTenantId: null,
    })
  })

  afterEach(() => {
    db.close()
  })

  test('save and findByTenantId', () => {
    const expiresAt = new Date(Date.now() + 60000)
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt,
    })

    const found = repo.findByTenantId('tenant-1')
    expect(found).not.toBeNull()
    expect(found?.tenantId).toBe('tenant-1')
    expect(found?.containerId).toBe('container-1')
    expect(found?.poolId).toBe('pool-1')
  })

  test('save updates existing reservation', () => {
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000),
    })

    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-2',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 120000),
    })

    const found = repo.findByTenantId('tenant-1')
    expect(found?.containerId).toBe('container-2')
  })

  test('delete', () => {
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000),
    })

    repo.delete('tenant-1')

    const found = repo.findByTenantId('tenant-1')
    expect(found).toBeNull()
  })

  test('deleteByContainerId', () => {
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000),
    })

    repo.deleteByContainerId('container-1')

    const found = repo.findByTenantId('tenant-1')
    expect(found).toBeNull()
  })

  test('findByPoolId', () => {
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000),
    })
    repo.save({
      tenantId: 'tenant-2',
      containerId: 'container-2',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000),
    })

    const reservations = repo.findByPoolId('pool-1')
    expect(reservations.length).toBe(2)
  })

  test('findActive excludes expired', () => {
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000), // Not expired
    })
    repo.save({
      tenantId: 'tenant-2',
      containerId: 'container-2',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() - 1000), // Expired
    })

    const active = repo.findActive()
    expect(active.length).toBe(1)
    expect(active[0].tenantId).toBe('tenant-1')
  })

  test('deleteExpired', () => {
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000),
    })
    repo.save({
      tenantId: 'tenant-2',
      containerId: 'container-2',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() - 1000),
    })

    const deleted = repo.deleteExpired()
    expect(deleted).toBe(1)

    const all = repo.findAll()
    expect(all.length).toBe(1)
    expect(all[0].tenantId).toBe('tenant-1')
  })

  test('cascade delete when container deleted', () => {
    repo.save({
      tenantId: 'tenant-1',
      containerId: 'container-1',
      poolId: 'pool-1',
      expiresAt: new Date(Date.now() + 60000),
    })

    containerRepo.delete('container-1')

    const found = repo.findByTenantId('tenant-1')
    expect(found).toBeNull()
  })
})
