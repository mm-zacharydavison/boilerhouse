/**
 * Container Claiming E2E Tests
 *
 * Tests for acquiring and releasing containers through the API.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TenantId } from '@boilerhouse/core'
import { type TestHarness, createTestHarness } from './harness'

describe('Container Claiming', () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = createTestHarness({
      useRealDocker: false,
      poolConfig: {
        minIdle: 0,
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
    const tenantId = TenantId('tenant-affinity-test')

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
    const tenantA = TenantId('tenant-A')
    const tenantB = TenantId('tenant-B')

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
    const tenants = [TenantId('tenant-1'), TenantId('tenant-2'), TenantId('tenant-3')]
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
    const tenants = [TenantId('tenant-1'), TenantId('tenant-2'), TenantId('tenant-3')]

    // Fill the pool to max capacity (3)
    for (const tenantId of tenants) {
      const claim = await harness.claimContainer(tenantId)
      expect(claim.status).toBe(200)
    }

    // Try to claim one more - should fail with 429 (pool at capacity)
    const overflow = await harness.claimContainer(TenantId('tenant-overflow'))
    expect(overflow.status).toBe(429)
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
        minIdle: 0,
        maxSize: 3,
        acquireTimeoutMs: 500,
      },
    })
    await harness.setup()

    const tenantId = TenantId('tenant-state-test')

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
        minIdle: 0,
        maxSize: 1, // Only 1 container, forces reuse
        acquireTimeoutMs: 2000,
      },
    })
    await harness.setup()

    const tenantA = TenantId('tenant-A')
    const tenantB = TenantId('tenant-B')

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

describe('Volume Seed Files', () => {
  let harness: TestHarness
  let seedDir: string

  beforeEach(async () => {
    // We need to create the harness with a custom base dir so we can set up seed files
    // before harness.setup() writes the workload YAML
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const baseDir = await mkdtemp(join(tmpdir(), 'seed-e2e-'))

    // Create seed directory with default files
    seedDir = join(baseDir, 'workloads', 'test-workload-seed')
    await mkdir(seedDir, { recursive: true })
    await writeFile(join(seedDir, 'config.json'), '{"theme":"dark","version":1}')
    await mkdir(join(seedDir, 'workspace'), { recursive: true })
    await writeFile(join(seedDir, 'workspace', 'SOUL.md'), '# Default Soul')

    harness = createTestHarness({
      useRealDocker: false,
      baseDir,
      workload: {
        id: 'test-workload' as import('@boilerhouse/core').WorkloadId,
        name: 'Test Workload',
        image: 'alpine:latest',
        command: ['sh', '-c', 'while true; do sleep 1; done'],
        volumes: {
          state: { target: '/state', readOnly: false, seed: seedDir },
          secrets: { target: '/secrets', readOnly: true },
          comm: { target: '/comm', readOnly: false },
        },
        environment: {
          STATE_DIR: '/state',
          TEST_MODE: 'true',
        },
        healthcheck: {
          test: ['CMD', 'true'],
          interval: 5000,
          timeout: 2000,
          retries: 3,
          startPeriod: 1000,
        },
      },
      poolConfig: {
        minIdle: 0,
        maxSize: 3,
        acquireTimeoutMs: 500,
      },
    })
    await harness.setup()
  })

  afterEach(async () => {
    await harness.teardown()
  })

  test('new tenant gets seed defaults in empty state directory', async () => {
    const tenantId = TenantId('tenant-new-seed')

    const claim = await harness.claimContainer(tenantId)
    expect(claim.status).toBe(200)
    const containerId = claim.data.containerId

    // Verify seed files exist on host state dir
    const stateDir = join(harness.baseDir, 'state', containerId)
    const files = await readdir(stateDir)
    expect(files).toContain('config.json')
    expect(files).toContain('workspace')

    // Verify file contents
    const config = await readFile(join(stateDir, 'config.json'), 'utf-8')
    expect(JSON.parse(config)).toEqual({ theme: 'dark', version: 1 })

    // Verify nested files
    const nestedFiles = await readdir(join(stateDir, 'workspace'))
    expect(nestedFiles).toContain('SOUL.md')
  })

  test('returning tenant (affinity) preserves mutations, seed skipped', async () => {
    const tenantId = TenantId('tenant-returning-seed')

    // First claim — seed applied
    const claim1 = await harness.claimContainer(tenantId)
    expect(claim1.status).toBe(200)
    const containerId = claim1.data.containerId

    const stateDir = join(harness.baseDir, 'state', containerId)

    // Tenant modifies a seed file
    await writeFile(join(stateDir, 'config.json'), '{"theme":"light","version":2}')

    // Release
    const release = await harness.releaseContainer(tenantId)
    expect(release.status).toBe(200)

    // Re-claim (affinity — same container, no wipe)
    const claim2 = await harness.claimContainer(tenantId)
    expect(claim2.status).toBe(200)
    expect(claim2.data.containerId).toBe(containerId)

    // Modified file should persist (seed not re-applied)
    const config = await readFile(join(stateDir, 'config.json'), 'utf-8')
    expect(JSON.parse(config)).toEqual({ theme: 'light', version: 2 })
  })

  test('different tenant gets fresh seed after wipe (isolation)', async () => {
    // Use a single-container pool to force reuse
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const baseDir = await mkdtemp(join(tmpdir(), 'seed-e2e-iso-'))

    const isoSeedDir = join(baseDir, 'workloads', 'test-workload-seed')
    await mkdir(isoSeedDir, { recursive: true })
    await writeFile(join(isoSeedDir, 'config.json'), '{"default":true}')

    const isoHarness = createTestHarness({
      useRealDocker: false,
      baseDir,
      workload: {
        id: 'test-workload' as import('@boilerhouse/core').WorkloadId,
        name: 'Test Workload',
        image: 'alpine:latest',
        command: ['sh', '-c', 'while true; do sleep 1; done'],
        volumes: {
          state: { target: '/state', readOnly: false, seed: isoSeedDir },
          secrets: { target: '/secrets', readOnly: true },
          comm: { target: '/comm', readOnly: false },
        },
        environment: { STATE_DIR: '/state', TEST_MODE: 'true' },
        healthcheck: {
          test: ['CMD', 'true'],
          interval: 5000,
          timeout: 2000,
          retries: 3,
          startPeriod: 1000,
        },
      },
      poolConfig: {
        minIdle: 0,
        maxSize: 1, // Force container reuse
        acquireTimeoutMs: 2000,
      },
    })
    await isoHarness.setup()

    try {
      const tenantA = TenantId('tenant-A-seed')
      const tenantB = TenantId('tenant-B-seed')

      // Tenant A claims → seed applied → modifies file → releases
      const claimA = await isoHarness.claimContainer(tenantA)
      expect(claimA.status).toBe(200)
      const containerId = claimA.data.containerId
      const stateDir = join(isoHarness.baseDir, 'state', containerId)

      await writeFile(join(stateDir, 'config.json'), '{"modified":"by-tenant-A"}')
      await writeFile(join(stateDir, 'tenant-a-only.txt'), 'private')

      const release = await isoHarness.releaseContainer(tenantA)
      expect(release.status).toBe(200)

      // Tenant B claims same container → wipe → seed re-applied with originals
      const claimB = await isoHarness.claimContainer(tenantB)
      expect(claimB.status).toBe(200)
      expect(claimB.data.containerId).toBe(containerId)

      // Tenant A's modifications should be gone
      const files = await readdir(stateDir)
      expect(files).not.toContain('tenant-a-only.txt')

      // Seed defaults should be restored
      expect(files).toContain('config.json')
      const config = await readFile(join(stateDir, 'config.json'), 'utf-8')
      expect(JSON.parse(config)).toEqual({ default: true })
    } finally {
      await isoHarness.teardown()
    }
  })

  test('repeated claim without release (idempotent) does NOT re-seed', async () => {
    const tenantId = TenantId('tenant-idempotent-seed')

    // First claim — seed applied
    const claim1 = await harness.claimContainer(tenantId)
    expect(claim1.status).toBe(200)
    const containerId = claim1.data.containerId

    const stateDir = join(harness.baseDir, 'state', containerId)

    // Tenant modifies a seed file
    await writeFile(join(stateDir, 'config.json'), '{"theme":"custom","version":99}')

    // Second claim without releasing — should be idempotent
    const claim2 = await harness.claimContainer(tenantId)
    expect(claim2.status).toBe(200)
    expect(claim2.data.containerId).toBe(containerId)

    // Modified file should persist (seed NOT re-applied)
    const config = await readFile(join(stateDir, 'config.json'), 'utf-8')
    expect(JSON.parse(config)).toEqual({ theme: 'custom', version: 99 })
  })

  test('no seed configured — state dir remains empty, no errors', async () => {
    const noSeedHarness = createTestHarness({
      useRealDocker: false,
      poolConfig: {
        minIdle: 0,
        maxSize: 3,
        acquireTimeoutMs: 500,
      },
    })
    await noSeedHarness.setup()

    try {
      const tenantId = TenantId('tenant-no-seed')
      const claim = await noSeedHarness.claimContainer(tenantId)
      expect(claim.status).toBe(200)

      const containerId = claim.data.containerId
      const stateDir = join(noSeedHarness.baseDir, 'state', containerId)
      const files = await readdir(stateDir)
      expect(files).toHaveLength(0)
    } finally {
      await noSeedHarness.teardown()
    }
  })
})
