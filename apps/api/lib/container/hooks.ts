/**
 * Lifecycle Hook Executor
 *
 * Runs hook commands inside containers at lifecycle points (post_claim, pre_release).
 * Commands are executed sequentially via runtime.exec() with per-hook timeout and
 * error handling (fail/continue/retry).
 */

import type { ContainerId, ContainerRuntime, HookCommand } from '@boilerhouse/core'
import type { ActivityLog } from '../activity'

export interface HookExecResult {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface HookRunResult {
  hookPoint: string
  results: HookExecResult[]
  aborted: boolean
  abortedAt?: number
}

export class HookError extends Error {
  hookPoint: string
  result: HookRunResult

  constructor(hookPoint: string, result: HookRunResult) {
    const failedResult = result.abortedAt != null ? result.results[result.abortedAt] : undefined
    const detail = failedResult
      ? `: ${failedResult.command.join(' ')} exited ${failedResult.exitCode}`
      : ''
    super(`Hook ${hookPoint} aborted${detail}`)
    this.name = 'HookError'
    this.hookPoint = hookPoint
    this.result = result
  }
}

/**
 * Execute a list of hook commands sequentially inside a container.
 *
 * Returns immediately (no-op) if hooks is undefined or empty.
 */
export async function runHooks(
  hookPoint: string,
  hooks: HookCommand[] | undefined,
  containerId: ContainerId,
  runtime: ContainerRuntime,
  activityLog: ActivityLog,
): Promise<HookRunResult> {
  if (!hooks || hooks.length === 0) {
    return { hookPoint, results: [], aborted: false }
  }

  const results: HookExecResult[] = []

  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i]

    activityLog.log('hook.started' as never, `Hook ${hookPoint}[${i}]: ${hook.command.join(' ')}`, {
      containerId,
      metadata: { hookPoint, index: i, command: hook.command },
    })

    const maxAttempts = hook.onError === 'retry' ? hook.retries : 1
    let lastResult: HookExecResult | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      lastResult = await execWithTimeout(containerId, hook.command, hook.timeout, runtime)

      if (lastResult.exitCode === 0) {
        break
      }
    }

    // lastResult is always set because maxAttempts >= 1
    const execResult = lastResult as HookExecResult
    results.push(execResult)

    if (execResult.exitCode === 0) {
      activityLog.log(
        'hook.completed' as never,
        `Hook ${hookPoint}[${i}] completed in ${execResult.durationMs}ms`,
        {
          containerId,
          metadata: {
            hookPoint,
            index: i,
            command: hook.command,
            durationMs: execResult.durationMs,
          },
        },
      )
      continue
    }

    // Hook failed
    const reason = execResult.timedOut
      ? `timed out after ${hook.timeout}ms`
      : `exited ${execResult.exitCode}`

    activityLog.log(
      'hook.failed' as never,
      `Hook ${hookPoint}[${i}] failed: ${reason} — ${execResult.stderr.slice(0, 200)}`,
      {
        containerId,
        metadata: {
          hookPoint,
          index: i,
          command: hook.command,
          exitCode: execResult.exitCode,
          timedOut: execResult.timedOut,
          stderr: execResult.stderr.slice(0, 500),
          durationMs: execResult.durationMs,
        },
      },
    )

    if (hook.onError === 'fail' || (hook.onError === 'retry' && execResult.exitCode !== 0)) {
      return { hookPoint, results, aborted: true, abortedAt: i }
    }

    // on_error: 'continue' — proceed to next hook
  }

  return { hookPoint, results, aborted: false }
}

async function execWithTimeout(
  containerId: ContainerId,
  command: string[],
  timeoutMs: number,
  runtime: ContainerRuntime,
): Promise<HookExecResult> {
  const start = Date.now()

  try {
    const result = await Promise.race([
      runtime.exec(containerId, command),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new TimeoutError()), timeoutMs),
      ),
    ])
    return {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - start,
      timedOut: false,
    }
  } catch (error) {
    const durationMs = Date.now() - start
    if (error instanceof TimeoutError) {
      return {
        command,
        exitCode: -1,
        stdout: '',
        stderr: `Hook timed out after ${timeoutMs}ms`,
        durationMs,
        timedOut: true,
      }
    }
    return {
      command,
      exitCode: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      durationMs,
      timedOut: false,
    }
  }
}

class TimeoutError extends Error {
  constructor() {
    super('timeout')
    this.name = 'TimeoutError'
  }
}
