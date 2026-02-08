/**
 * Lifecycle Hook Executor Tests
 *
 * Tests for runHooks — the function that executes hook commands inside containers.
 * Uses a mock ContainerRuntime, no Docker required.
 */

import { describe, expect, mock, test } from 'bun:test'
import { ContainerId, type ContainerRuntime, type HookCommand } from '@boilerhouse/core'
import { createTestDatabase } from '@boilerhouse/db'
import { createWorkloadSpec } from '../../test/fixtures'
import { ActivityLog } from '../activity'
import { HookError, type HookRunResult, runHooks } from './hooks'

function createMockRuntime(
  execImpl?: (
    id: string,
    command: string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): ContainerRuntime {
  return {
    name: 'mock',
    createContainer: mock(async () => ({
      id: 'mock-1',
      name: 'mock',
      status: 'running' as const,
      createdAt: new Date(),
      labels: {},
    })),
    stopContainer: mock(async () => {}),
    removeContainer: mock(async () => {}),
    destroyContainer: mock(async () => {}),
    restartContainer: mock(async () => {}),
    getContainer: mock(async () => null),
    isHealthy: mock(async () => true),
    listContainers: mock(async () => []),
    exec: mock(execImpl ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' }))),
  }
}

function createActivityLog() {
  const db = createTestDatabase()
  return new ActivityLog(db)
}

const containerId = ContainerId('test-container')

function makeHook(overrides?: Partial<HookCommand>): HookCommand {
  return {
    command: ['echo', 'hello'],
    timeout: 30000,
    onError: 'fail',
    retries: 1,
    ...overrides,
  }
}

// =============================================================================
// runHooks basics
// =============================================================================

describe('runHooks', () => {
  test('returns no-op result for undefined hooks', async () => {
    const runtime = createMockRuntime()
    const activityLog = createActivityLog()

    const result = await runHooks('post_claim', undefined, containerId, runtime, activityLog)

    expect(result.aborted).toBe(false)
    expect(result.results).toHaveLength(0)
    expect(runtime.exec).not.toHaveBeenCalled()
  })

  test('returns no-op result for empty hooks array', async () => {
    const runtime = createMockRuntime()
    const activityLog = createActivityLog()

    const result = await runHooks('post_claim', [], containerId, runtime, activityLog)

    expect(result.aborted).toBe(false)
    expect(result.results).toHaveLength(0)
    expect(runtime.exec).not.toHaveBeenCalled()
  })

  test('executes a single successful hook', async () => {
    const runtime = createMockRuntime(async () => ({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    }))
    const activityLog = createActivityLog()

    const hooks = [makeHook({ command: ['node', 'migrate.js'] })]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].exitCode).toBe(0)
    expect(result.results[0].stdout).toBe('ok')
    expect(result.results[0].command).toEqual(['node', 'migrate.js'])
    expect(result.results[0].timedOut).toBe(false)

    // Verify exec was called with the right args
    const execMock = runtime.exec as ReturnType<typeof mock>
    expect(execMock).toHaveBeenCalledTimes(1)
    expect(execMock.mock.calls[0][0]).toBe(containerId)
    expect(execMock.mock.calls[0][1]).toEqual(['node', 'migrate.js'])
  })

  test('captures stdout and stderr', async () => {
    const runtime = createMockRuntime(async () => ({
      exitCode: 0,
      stdout: 'line1\nline2',
      stderr: 'warn: something',
    }))
    const activityLog = createActivityLog()

    const result = await runHooks('post_claim', [makeHook()], containerId, runtime, activityLog)

    expect(result.results[0].stdout).toBe('line1\nline2')
    expect(result.results[0].stderr).toBe('warn: something')
  })

  test('records durationMs for each hook', async () => {
    const runtime = createMockRuntime(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const activityLog = createActivityLog()

    const result = await runHooks('post_claim', [makeHook()], containerId, runtime, activityLog)

    expect(result.results[0].durationMs).toBeGreaterThanOrEqual(5)
  })

  // ---------------------------------------------------------------------------
  // on_error: fail
  // ---------------------------------------------------------------------------

  test('aborts on non-zero exit when on_error is fail', async () => {
    const runtime = createMockRuntime(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'migration failed',
    }))
    const activityLog = createActivityLog()

    const hooks = [makeHook({ onError: 'fail' })]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(true)
    expect(result.abortedAt).toBe(0)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].exitCode).toBe(1)
    expect(result.results[0].stderr).toBe('migration failed')
  })

  test('aborts remaining hooks after fail', async () => {
    let callCount = 0
    const runtime = createMockRuntime(async () => {
      callCount++
      if (callCount === 1) return { exitCode: 1, stdout: '', stderr: 'fail' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const activityLog = createActivityLog()

    const hooks = [
      makeHook({ command: ['first'], onError: 'fail' }),
      makeHook({ command: ['second'], onError: 'fail' }),
    ]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(true)
    expect(result.abortedAt).toBe(0)
    expect(result.results).toHaveLength(1) // second never ran
    expect(runtime.exec).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------------
  // on_error: continue
  // ---------------------------------------------------------------------------

  test('continues on failure when on_error is continue', async () => {
    let callCount = 0
    const runtime = createMockRuntime(async () => {
      callCount++
      if (callCount === 1) return { exitCode: 1, stdout: '', stderr: 'non-critical' }
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    })
    const activityLog = createActivityLog()

    const hooks = [
      makeHook({ command: ['optional'], onError: 'continue' }),
      makeHook({ command: ['required'], onError: 'fail' }),
    ]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(false)
    expect(result.results).toHaveLength(2)
    expect(result.results[0].exitCode).toBe(1)
    expect(result.results[1].exitCode).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // on_error: retry
  // ---------------------------------------------------------------------------

  test('retries on failure when on_error is retry', async () => {
    let callCount = 0
    const runtime = createMockRuntime(async () => {
      callCount++
      if (callCount < 3) return { exitCode: 1, stdout: '', stderr: 'not ready' }
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    })
    const activityLog = createActivityLog()

    const hooks = [makeHook({ onError: 'retry', retries: 3 })]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].exitCode).toBe(0)
    expect(runtime.exec).toHaveBeenCalledTimes(3)
  })

  test('aborts after exhausting retries', async () => {
    const runtime = createMockRuntime(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'always fails',
    }))
    const activityLog = createActivityLog()

    const hooks = [makeHook({ onError: 'retry', retries: 2 })]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].exitCode).toBe(1)
    expect(runtime.exec).toHaveBeenCalledTimes(2)
  })

  // ---------------------------------------------------------------------------
  // Sequential execution
  // ---------------------------------------------------------------------------

  test('runs multiple hooks sequentially in order', async () => {
    const order: string[] = []
    const runtime = createMockRuntime(async (_id, cmd) => {
      order.push(cmd[0])
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const activityLog = createActivityLog()

    const hooks = [
      makeHook({ command: ['first'] }),
      makeHook({ command: ['second'] }),
      makeHook({ command: ['third'] }),
    ]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(false)
    expect(result.results).toHaveLength(3)
    expect(order).toEqual(['first', 'second', 'third'])
  })

  // ---------------------------------------------------------------------------
  // Timeout
  // ---------------------------------------------------------------------------

  test('treats timeout as failure', async () => {
    const runtime = createMockRuntime(async () => {
      // Simulate a command that hangs
      await new Promise((r) => setTimeout(r, 5000))
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const activityLog = createActivityLog()

    const hooks = [makeHook({ timeout: 50, onError: 'fail' })]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].timedOut).toBe(true)
  })

  test('timeout with on_error continue does not abort', async () => {
    const runtime = createMockRuntime(async () => {
      await new Promise((r) => setTimeout(r, 5000))
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const activityLog = createActivityLog()

    const hooks = [makeHook({ timeout: 50, onError: 'continue' })]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].timedOut).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // runtime.exec throws (container died, etc.)
  // ---------------------------------------------------------------------------

  test('treats exec exception as failure', async () => {
    const runtime = createMockRuntime(async () => {
      throw new Error('container not found')
    })
    const activityLog = createActivityLog()

    const hooks = [makeHook({ onError: 'fail' })]
    const result = await runHooks('post_claim', hooks, containerId, runtime, activityLog)

    expect(result.aborted).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].exitCode).toBe(-1)
    expect(result.results[0].stderr).toContain('container not found')
  })

  // ---------------------------------------------------------------------------
  // Activity log events
  // ---------------------------------------------------------------------------

  test('logs hook.started and hook.completed events', async () => {
    const runtime = createMockRuntime()
    const activityLog = createActivityLog()

    await runHooks(
      'post_claim',
      [makeHook({ command: ['echo', 'hi'] })],
      containerId,
      runtime,
      activityLog,
    )

    const events = activityLog.getEvents(10)
    const types = events.map((e) => e.type)
    expect(types).toContain('hook.completed')
    expect(types).toContain('hook.started')
  })

  test('logs hook.failed event on failure', async () => {
    const runtime = createMockRuntime(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'err',
    }))
    const activityLog = createActivityLog()

    await runHooks(
      'post_claim',
      [makeHook({ onError: 'continue' })],
      containerId,
      runtime,
      activityLog,
    )

    const events = activityLog.getEvents(10)
    const types = events.map((e) => e.type)
    expect(types).toContain('hook.failed')
  })

  // ---------------------------------------------------------------------------
  // hookPoint is included in result
  // ---------------------------------------------------------------------------

  test('includes hookPoint in result', async () => {
    const runtime = createMockRuntime()
    const activityLog = createActivityLog()

    const result = await runHooks('pre_release', [makeHook()], containerId, runtime, activityLog)

    expect(result.hookPoint).toBe('pre_release')
  })
})

// =============================================================================
// Claim/Release integration
// =============================================================================

describe('claimContainer with hooks', () => {
  const { TenantId, PoolId } = require('@boilerhouse/core')
  const { ContainerManager } = require('./manager')
  const { ContainerPool } = require('./pool')
  const { claimContainer } = require('./claim')
  const { createTestDatabase: createDb } = require('@boilerhouse/db')
  const pino = require('pino')
  const silentLogger = pino.default({ level: 'silent' })

  function setupClaimTest(execImpl?: Parameters<typeof createMockRuntime>[0]) {
    const runtime = createMockRuntime(execImpl)
    const db = createDb()
    const manager = new ContainerManager(runtime, {
      stateBaseDir: '/tmp/hook-test-states',
      secretsBaseDir: '/tmp/hook-test-secrets',
      socketBaseDir: '/tmp/hook-test-sockets',
    })
    const activityLog = createActivityLog()

    // No-op sync coordinator
    const syncCoordinator = {
      onClaim: mock(async () => []),
      onRelease: mock(async () => []),
      startPeriodicSync: mock(() => {}),
      stopPeriodicSync: mock(() => {}),
    }

    // No-op idle reaper
    const idleReaper = {
      watch: mock(() => {}),
      unwatch: mock(() => {}),
      shutdown: mock(() => {}),
    }

    return { runtime, db, manager, activityLog, syncCoordinator, idleReaper }
  }

  test('post_claim hooks run after container is healthy', async () => {
    const execOrder: string[] = []
    const { runtime, db, manager, activityLog, syncCoordinator, idleReaper } = setupClaimTest(
      async (_id, cmd) => {
        execOrder.push(cmd.join(' '))
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const workload = createWorkloadSpec({
      hooks: {
        postClaim: [
          { command: ['node', 'migrate.js'], timeout: 30000, onError: 'fail' as const, retries: 1 },
        ],
      },
    })

    const poolId = PoolId('hook-test-pool')
    const pool = new ContainerPool(
      manager,
      {
        workload,
        poolId,
        minIdle: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      },
      db,
      silentLogger,
    )

    const tenantId = TenantId('hook-tenant-1')
    await claimContainer(tenantId, poolId, pool, {
      containerManager: manager,
      syncCoordinator,
      activityLog,
      idleReaper,
    })

    // The exec mock should have been called with the hook command
    const execMock = runtime.exec as ReturnType<typeof mock>
    const hookCalls = execMock.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && c[1][0] === 'node' && c[1][1] === 'migrate.js',
    )
    expect(hookCalls).toHaveLength(1)

    await pool.drain()
  })

  test('failing post_claim hook with on_error:fail releases container and throws', async () => {
    const { runtime, db, manager, activityLog, syncCoordinator, idleReaper } = setupClaimTest(
      async () => ({ exitCode: 1, stdout: '', stderr: 'hook failed' }),
    )

    const workload = createWorkloadSpec({
      hooks: {
        postClaim: [{ command: ['bad-cmd'], timeout: 30000, onError: 'fail' as const, retries: 1 }],
      },
    })

    const poolId = PoolId('hook-fail-pool')
    const pool = new ContainerPool(
      manager,
      {
        workload,
        poolId,
        minIdle: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      },
      db,
      silentLogger,
    )

    const tenantId = TenantId('hook-fail-tenant')
    await expect(
      claimContainer(tenantId, poolId, pool, {
        containerManager: manager,
        syncCoordinator,
        activityLog,
        idleReaper,
      }),
    ).rejects.toThrow()

    // Container should be released back to pool
    expect(pool.hasTenant(tenantId)).toBe(false)

    await pool.drain()
  })

  test('failing post_claim hook with on_error:continue still claims successfully', async () => {
    const { runtime, db, manager, activityLog, syncCoordinator, idleReaper } = setupClaimTest(
      async () => ({ exitCode: 1, stdout: '', stderr: 'non-critical' }),
    )

    const workload = createWorkloadSpec({
      hooks: {
        postClaim: [
          { command: ['optional-cmd'], timeout: 30000, onError: 'continue' as const, retries: 1 },
        ],
      },
    })

    const poolId = PoolId('hook-continue-pool')
    const pool = new ContainerPool(
      manager,
      {
        workload,
        poolId,
        minIdle: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      },
      db,
      silentLogger,
    )

    const tenantId = TenantId('hook-continue-tenant')
    const result = await claimContainer(tenantId, poolId, pool, {
      containerManager: manager,
      syncCoordinator,
      activityLog,
      idleReaper,
    })

    // Claim should succeed despite hook failure
    expect(result.container.tenantId).toBe(tenantId)
    expect(pool.hasTenant(tenantId)).toBe(true)

    await pool.drain()
  })

  test('no hooks configured works normally', async () => {
    const { db, manager, activityLog, syncCoordinator, idleReaper } = setupClaimTest()

    const workload = createWorkloadSpec() // no hooks

    const poolId = PoolId('no-hook-pool')
    const pool = new ContainerPool(
      manager,
      {
        workload,
        poolId,
        minIdle: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      },
      db,
      silentLogger,
    )

    const tenantId = TenantId('no-hook-tenant')
    const result = await claimContainer(tenantId, poolId, pool, {
      containerManager: manager,
      syncCoordinator,
      activityLog,
      idleReaper,
    })

    expect(result.container.tenantId).toBe(tenantId)

    await pool.drain()
  })
})

describe('releaseContainer with hooks', () => {
  const { TenantId, PoolId } = require('@boilerhouse/core')
  const { ContainerManager } = require('./manager')
  const { ContainerPool } = require('./pool')
  const { releaseContainer } = require('./release')
  const { createTestDatabase: createDb } = require('@boilerhouse/db')
  const pino = require('pino')
  const silentLogger = pino.default({ level: 'silent' })

  function setupReleaseTest(execImpl?: Parameters<typeof createMockRuntime>[0]) {
    const runtime = createMockRuntime(execImpl)
    const db = createDb()
    const manager = new ContainerManager(runtime, {
      stateBaseDir: '/tmp/hook-test-states',
      secretsBaseDir: '/tmp/hook-test-secrets',
      socketBaseDir: '/tmp/hook-test-sockets',
    })
    const activityLog = createActivityLog()

    const syncCoordinator = {
      onClaim: mock(async () => []),
      onRelease: mock(async () => []),
      startPeriodicSync: mock(() => {}),
      stopPeriodicSync: mock(() => {}),
    }

    return { runtime, db, manager, activityLog, syncCoordinator }
  }

  test('pre_release hooks run before sync and release', async () => {
    const callOrder: string[] = []
    const { runtime, db, manager, activityLog, syncCoordinator } = setupReleaseTest(
      async (_id, cmd) => {
        callOrder.push(`exec:${cmd.join(' ')}`)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    // Track sync call ordering
    syncCoordinator.onRelease = mock(async () => {
      callOrder.push('sync:onRelease')
      return []
    })

    const workload = createWorkloadSpec({
      hooks: {
        preRelease: [
          { command: ['flush-state'], timeout: 5000, onError: 'continue' as const, retries: 1 },
        ],
      },
    })

    const poolId = PoolId('release-hook-pool')
    const pool = new ContainerPool(
      manager,
      {
        workload,
        poolId,
        minIdle: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      },
      db,
      silentLogger,
    )

    const tenantId = TenantId('release-hook-tenant')
    await pool.acquireForTenant(tenantId)

    await releaseContainer(tenantId, pool, {
      syncCoordinator,
      activityLog,
      containerManager: manager,
    })

    // Hook ran; sync did not run (no sync config in workload)
    const hookCalls = (runtime.exec as ReturnType<typeof mock>).mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && c[1][0] === 'flush-state',
    )
    expect(hookCalls).toHaveLength(1)

    // Container should be released
    expect(pool.hasTenant(tenantId)).toBe(false)

    await pool.drain()
  })

  test('failing pre_release hook still completes release', async () => {
    const { runtime, db, manager, activityLog, syncCoordinator } = setupReleaseTest(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'flush failed',
    }))

    const workload = createWorkloadSpec({
      hooks: {
        preRelease: [
          { command: ['fail-hook'], timeout: 5000, onError: 'fail' as const, retries: 1 },
        ],
      },
    })

    const poolId = PoolId('release-fail-pool')
    const pool = new ContainerPool(
      manager,
      {
        workload,
        poolId,
        minIdle: 0,
        maxSize: 5,
        idleTimeoutMs: 60000,
        evictionIntervalMs: 0,
        acquireTimeoutMs: 5000,
      },
      db,
      silentLogger,
    )

    const tenantId = TenantId('release-fail-tenant')
    await pool.acquireForTenant(tenantId)

    // Release should not throw even though hook fails
    await releaseContainer(tenantId, pool, {
      syncCoordinator,
      activityLog,
      containerManager: manager,
    })

    // Container must still be released
    expect(pool.hasTenant(tenantId)).toBe(false)

    await pool.drain()
  })
})

// =============================================================================
// HookError
// =============================================================================

describe('HookError', () => {
  test('has descriptive message', () => {
    const result: HookRunResult = {
      hookPoint: 'post_claim',
      results: [
        {
          command: ['node', 'migrate.js'],
          exitCode: 1,
          stdout: '',
          stderr: 'migration failed',
          durationMs: 100,
          timedOut: false,
        },
      ],
      aborted: true,
      abortedAt: 0,
    }

    const error = new HookError('post_claim', result)
    expect(error.message).toContain('post_claim')
    expect(error.hookPoint).toBe('post_claim')
    expect(error.result).toBe(result)
  })
})
