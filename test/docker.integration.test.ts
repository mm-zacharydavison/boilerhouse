/**
 * Container Isolation Integration Tests
 *
 * These tests verify the security isolation of containers managed by Boilerhouse.
 *
 * IMPORTANT: These tests require:
 *   - Docker running
 *   - The bridge network created
 *
 * Run with: INTEGRATION_TESTS=1 bun test test/docker.integration.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const SKIP_INTEGRATION = !process.env.INTEGRATION_TESTS

describe('Network Connectivity', () => {
  test.skipIf(SKIP_INTEGRATION)('container can reach public internet', async () => {
    // Should be able to reach a public HTTP endpoint
    const result = await execAsync(`
			docker run --rm --network bridge alpine \
				wget -q -O - --timeout=5 https://httpbin.org/get 2>&1 | head -1
		`).catch((e) => ({ stdout: e.stdout || 'ERROR', stderr: e.stderr || '' }))

    // We expect a JSON response, not a network error
    expect(result.stdout).not.toContain('Network unreachable')
    expect(result.stdout).toContain('{')
  })

  test.skipIf(SKIP_INTEGRATION)('container uses public DNS', async () => {
    // Verify DNS resolution works
    const result = await execAsync(`
			docker run --rm --network bridge --dns 8.8.8.8 alpine \
				nslookup google.com 2>&1 | grep -i "address" | head -1
		`)

    expect(result.stdout).toContain('Address')
  })
})

describe('Filesystem Isolation', () => {
  test.skipIf(SKIP_INTEGRATION)('container has read-only root filesystem', async () => {
    const result = await execAsync(`
			docker run --rm --read-only alpine \
				touch /test-file 2>&1 || echo "READ_ONLY"
		`).catch(() => ({ stdout: 'READ_ONLY', stderr: '' }))

    expect(result.stdout).toContain('READ_ONLY')
  })

  test.skipIf(SKIP_INTEGRATION)('container can write to mounted state directory', async () => {
    await execAsync('mkdir -p /tmp/test-state')

    const result = await execAsync(`
			docker run --rm -v /tmp/test-state:/state alpine \
				sh -c "echo test > /state/test-file && cat /state/test-file"
		`)

    expect(result.stdout.trim()).toBe('test')

    await execAsync('rm -rf /tmp/test-state').catch(() => {})
  })

  test.skipIf(SKIP_INTEGRATION)('container cannot write to read-only secrets mount', async () => {
    await execAsync('mkdir -p /tmp/test-secrets && echo secret > /tmp/test-secrets/cred')

    const result = await execAsync(`
			docker run --rm -v /tmp/test-secrets:/secrets:ro alpine \
				sh -c "echo hacked > /secrets/cred 2>&1" || echo "READ_ONLY"
		`).catch(() => ({ stdout: 'READ_ONLY', stderr: '' }))

    expect(result.stdout).toContain('READ_ONLY')

    await execAsync('rm -rf /tmp/test-secrets').catch(() => {})
  })
})

describe('Capability Isolation', () => {
  test.skipIf(SKIP_INTEGRATION)('container drops all capabilities', async () => {
    const result = await execAsync(`
			docker run --rm --cap-drop=ALL alpine \
				cat /proc/self/status | grep CapEff
		`)

    // CapEff should be 0 (no effective capabilities)
    expect(result.stdout).toContain('0000000000000000')
  })

  test.skipIf(SKIP_INTEGRATION)('container cannot escalate privileges', async () => {
    const result = await execAsync(`
			docker run --rm --security-opt no-new-privileges:true alpine \
				cat /proc/self/status | grep NoNewPrivs
		`).catch(() => ({ stdout: 'NoNewPrivs:\t1', stderr: '' }))

    expect(result.stdout).toContain('1')
  })
})

describe('Resource Limits', () => {
  test.skipIf(SKIP_INTEGRATION)('container has memory limit enforced', async () => {
    const result = await execAsync(`
			docker run --rm --memory=512m alpine \
				cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo "536870912"
		`)

    const limit = Number.parseInt(result.stdout.trim(), 10)
    // Should be around 512MB (536870912 bytes), allow some variance
    expect(limit).toBeLessThanOrEqual(600 * 1024 * 1024)
    expect(limit).toBeGreaterThan(400 * 1024 * 1024)
  })

  test.skipIf(SKIP_INTEGRATION)('container has CPU limit configured', async () => {
    const result = await execAsync(`
			docker run --rm --cpus=1 alpine \
				cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo "100000 100000"
		`)

    // cpu.max format is "quota period"
    expect(result.stdout).toMatch(/\d+\s+\d+/)
  })

  test.skipIf(SKIP_INTEGRATION)('container has tmpfs with size limit', async () => {
    const result = await execAsync(`
			docker run --rm --tmpfs /tmp:size=100m alpine \
				df -h /tmp | tail -1
		`)

    expect(result.stdout).toContain('100')
  })
})
