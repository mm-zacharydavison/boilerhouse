/**
 * Workload Loader Tests
 *
 * Tests for seed path resolution and validation in the workload loader.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkloadValidationError, loadWorkloadFile } from './loader'

describe('Workload Loader - Seed Path Resolution', () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'loader-test-'))
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  test('relative seed path is resolved against YAML file directory', async () => {
    const seedDir = join(baseDir, 'my-seed')
    await mkdir(seedDir, { recursive: true })
    await writeFile(join(seedDir, 'default.json'), '{}')

    const yamlContent = `
id: test-workload
name: Test Workload
image: alpine:latest
volumes:
  state:
    target: /state
    seed: ./my-seed
healthcheck:
  test: ["CMD", "true"]
  interval: 5s
  timeout: 2s
  retries: 3
`
    const yamlFile = join(baseDir, 'test-workload.yaml')
    await writeFile(yamlFile, yamlContent)

    const spec = loadWorkloadFile(yamlFile)

    // Seed path should be resolved to absolute
    expect(spec.volumes.state?.seed).toBe(seedDir)
  })

  test('absolute seed path is kept as-is', async () => {
    const seedDir = join(baseDir, 'absolute-seed')
    await mkdir(seedDir, { recursive: true })

    const yamlContent = `
id: test-workload
name: Test Workload
image: alpine:latest
volumes:
  state:
    target: /state
    seed: ${seedDir}
healthcheck:
  test: ["CMD", "true"]
  interval: 5s
  timeout: 2s
  retries: 3
`
    const yamlFile = join(baseDir, 'test-workload.yaml')
    await writeFile(yamlFile, yamlContent)

    const spec = loadWorkloadFile(yamlFile)

    expect(spec.volumes.state?.seed).toBe(seedDir)
  })

  test('missing seed directory throws WorkloadValidationError at load time', async () => {
    const yamlContent = `
id: test-workload
name: Test Workload
image: alpine:latest
volumes:
  state:
    target: /state
    seed: ./nonexistent-seed
healthcheck:
  test: ["CMD", "true"]
  interval: 5s
  timeout: 2s
  retries: 3
`
    const yamlFile = join(baseDir, 'test-workload.yaml')
    await writeFile(yamlFile, yamlContent)

    expect(() => loadWorkloadFile(yamlFile)).toThrow(WorkloadValidationError)
  })

  test('workload without seed field loads normally', async () => {
    const yamlContent = `
id: test-workload
name: Test Workload
image: alpine:latest
volumes:
  state:
    target: /state
healthcheck:
  test: ["CMD", "true"]
  interval: 5s
  timeout: 2s
  retries: 3
`
    const yamlFile = join(baseDir, 'test-workload.yaml')
    await writeFile(yamlFile, yamlContent)

    const spec = loadWorkloadFile(yamlFile)

    expect(spec.volumes.state?.seed).toBeUndefined()
    expect(spec.id).toBe('test-workload')
  })

  test('seed on secrets volume is resolved', async () => {
    const seedDir = join(baseDir, 'secrets-seed')
    await mkdir(seedDir, { recursive: true })
    await writeFile(join(seedDir, '.env'), 'KEY=value')

    const yamlContent = `
id: test-workload
name: Test Workload
image: alpine:latest
volumes:
  secrets:
    target: /secrets
    read_only: true
    seed: ./secrets-seed
healthcheck:
  test: ["CMD", "true"]
  interval: 5s
  timeout: 2s
  retries: 3
`
    const yamlFile = join(baseDir, 'test-workload.yaml')
    await writeFile(yamlFile, yamlContent)

    const spec = loadWorkloadFile(yamlFile)

    expect(spec.volumes.secrets?.seed).toBe(seedDir)
  })
})
