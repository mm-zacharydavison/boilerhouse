/**
 * Container Claiming E2E Tests
 *
 * Tests for acquiring and releasing containers through the API.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type TestHarness, createTestHarness } from './harness'

describe('Container Claiming', () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = createTestHarness({
      useRealDocker: false,
      poolConfig: {
        minSize: 0,
        maxSize: 3,
        acquireTimeoutMs: 500, // Short timeout for capacity tests
      },
    })
    await harness.setup()
  })

  afterEach(async () => {
    await harness.teardown()
  })

  test('tenant gets same container back after release (affinity)', async () => {
    const tenantId = 'tenant-affinity-test'

    // First claim
    const claim1 = await harness.claimContainer(tenantId)
    expect(claim1.status).toBe(200)
    const containerId1 = claim1.data.containerId

    // Release
    const release = await harness.releaseContainer(tenantId)
    expect(release.status).toBe(200)
    expect(release.data.success).toBe(true)

    // Second claim - should get same container due to affinity
    const claim2 = await harness.claimContainer(tenantId)
    expect(claim2.status).toBe(200)
    const containerId2 = claim2.data.containerId

    expect(containerId2).toBe(containerId1)
  })

  test('different tenants get different containers', async () => {
    const tenantA = 'tenant-A'
    const tenantB = 'tenant-B'

    // Tenant A claims
    const claimA = await harness.claimContainer(tenantA)
    expect(claimA.status).toBe(200)

    // Tenant B claims
    const claimB = await harness.claimContainer(tenantB)
    expect(claimB.status).toBe(200)

    // Should be different containers
    expect(claimA.data.containerId).not.toBe(claimB.data.containerId)

    // Verify both tenants have containers
    expect(harness.hasTenant(tenantA)).toBe(true)
    expect(harness.hasTenant(tenantB)).toBe(true)
  })

  test('pool scales up when all containers are claimed', async () => {
    const tenants = ['tenant-1', 'tenant-2', 'tenant-3']
    const containerIds: string[] = []

    // Claim containers for all tenants (should scale up from 0 to 3)
    for (const tenantId of tenants) {
      const claim = await harness.claimContainer(tenantId)
      expect(claim.status).toBe(200)
      containerIds.push(claim.data.containerId)
    }

    // All container IDs should be unique
    const uniqueIds = new Set(containerIds)
    expect(uniqueIds.size).toBe(3)

    // Pool should show all containers borrowed
    const stats = harness.getPoolStats()
    expect(stats).not.toBeNull()
    expect(stats?.borrowed).toBe(3)
    expect(stats?.available).toBe(0)
  })

  test('returns error when pool is at max capacity', async () => {
    const tenants = ['tenant-1', 'tenant-2', 'tenant-3']

    // Fill the pool to max capacity (3)
    for (const tenantId of tenants) {
      const claim = await harness.claimContainer(tenantId)
      expect(claim.status).toBe(200)
    }

    // Try to claim one more - should fail
    const overflow = await harness.claimContainer('tenant-overflow')
    expect(overflow.status).toBe(500)
    expect(overflow.data).toHaveProperty('error')

    // Verify pool is at capacity
    const stats = harness.getPoolStats()
    expect(stats?.borrowed).toBe(3)
    expect(stats?.size).toBe(3)
  })
})

describe('Container State Wiping', () => {
  let harness: TestHarness

  afterEach(async () => {
    await harness.teardown()
  })

  test('same tenant reclaiming does NOT wipe state', async () => {
    harness = createTestHarness({
      useRealDocker: false,
      poolConfig: {
        minSize: 0,
        maxSize: 3,
        acquireTimeoutMs: 500,
      },
    })
    await harness.setup()

    const tenantId = 'tenant-state-test'

    // Claim container
    const claim1 = await harness.claimContainer(tenantId)
    expect(claim1.status).toBe(200)
    const containerId = claim1.data.containerId

    // Write a file to the container's host state directory
    const stateDir = join(harness.baseDir, 'state', containerId)
    const testFile = join(stateDir, 'tenant-data.txt')
    await writeFile(testFile, 'important tenant data')

    // Verify file exists
    let files = await readdir(stateDir)
    expect(files).toContain('tenant-data.txt')

    // Release container
    const release = await harness.releaseContainer(tenantId)
    expect(release.status).toBe(200)

    // File should still exist after release (no wipe on release)
    files = await readdir(stateDir)
    expect(files).toContain('tenant-data.txt')

    // Same tenant reclaims - should get same container with data intact
    const claim2 = await harness.claimContainer(tenantId)
    expect(claim2.status).toBe(200)
    expect(claim2.data.containerId).toBe(containerId)

    // File should still exist (affinity = no wipe)
    files = await readdir(stateDir)
    expect(files).toContain('tenant-data.txt')
  })

  test('different tenant claiming DOES wipe state', async () => {
    harness = createTestHarness({
      useRealDocker: false,
      poolConfig: {
        minSize: 0,
        maxSize: 1, // Only 1 container, forces reuse
        acquireTimeoutMs: 2000,
      },
    })
    await harness.setup()

    const tenantA = 'tenant-A'
    const tenantB = 'tenant-B'

    // Tenant A claims
    const claimA = await harness.claimContainer(tenantA)
    expect(claimA.status).toBe(200)
    const containerId = claimA.data.containerId

    // Write a file to the container's host state directory
    const stateDir = join(harness.baseDir, 'state', containerId)
    const testFile = join(stateDir, 'tenant-a-secret.txt')
    await writeFile(testFile, 'tenant A secret data')

    // Verify file exists
    let files = await readdir(stateDir)
    expect(files).toContain('tenant-a-secret.txt')

    // Release container (goes straight to idle with lastTenantId set)
    const release = await harness.releaseContainer(tenantA)
    expect(release.status).toBe(200)

    // Tenant B claims - gets same container (only 1 in pool), wipe-on-entry triggers
    const claimB = await harness.claimContainer(tenantB)
    expect(claimB.status).toBe(200)
    expect(claimB.data.containerId).toBe(containerId) // Same container (only 1 in pool)

    // File should be GONE (wiped for new tenant)
    files = await readdir(stateDir)
    expect(files).not.toContain('tenant-a-secret.txt')
  })
})
