/**
 * Idle Reaper
 *
 * Monitors claimed containers for filesystem inactivity by polling mtime.
 * A single poll loop walks the state directory tree for each watched container,
 * checking if any file or directory has been modified since the last poll.
 * When no modifications are detected for the configured TTL, the container
 * is automatically released back to the pool.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { and, eq } from 'drizzle-orm'
import {
  idleReaperExpirations,
  idleReaperFileWatchCount,
  idleReaperResets,
  idleReaperWatchesActive,
} from '../metrics'
import type { ContainerManager } from './manager'
import type { ContainerPool } from './pool'

interface WatchedContainer {
  containerId: ContainerId
  tenantId: TenantId
  poolId: PoolId
  stateDir: string
  ttlMs: number
  /** Timestamp (ms) of the most recent mtime seen across all files in the state dir */
  lastModified: number
  /** Whether a debounced DB update is pending */
  dbUpdatePending: boolean
}

const DEFAULT_POLL_INTERVAL_MS = 5000

export interface IdleReaperDeps {
  db: DrizzleDb
  onExpiry: (containerId: ContainerId, tenantId: TenantId, poolId: PoolId) => Promise<void>
  /** How often to poll state directories for mtime changes (default: 5000ms) */
  pollIntervalMs?: number
}

export class IdleReaper {
  private watches = new Map<ContainerId, WatchedContainer>()
  private db: DrizzleDb
  private onExpiry: IdleReaperDeps['onExpiry']
  private pollIntervalMs: number
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: IdleReaperDeps) {
    this.db = deps.db
    this.onExpiry = deps.onExpiry
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  /**
   * Start watching a container's state directory for filesystem inactivity.
   * Must be called after the full claim flow (acquire + wipe + sync + restart).
   */
  watch(
    containerId: ContainerId,
    tenantId: TenantId,
    poolId: PoolId,
    stateDir: string,
    ttlMs: number,
  ): void {
    // Clean up any existing watch for this container
    if (this.watches.has(containerId)) {
      this.unwatch(containerId)
    }

    const now = Date.now()
    this.watches.set(containerId, {
      containerId,
      tenantId,
      poolId,
      stateDir,
      ttlMs,
      lastModified: now,
      dbUpdatePending: false,
    })

    // Persist expiry timestamp so the dashboard can show a countdown
    this.db
      .update(schema.containers)
      .set({ idleExpiresAt: new Date(now + ttlMs) })
      .where(eq(schema.containers.containerId, containerId))
      .run()

    idleReaperWatchesActive.inc({ pool_id: poolId })

    // Start the shared poll loop if not already running
    this.ensurePollLoop()
  }

  /**
   * Stop watching a container. Called on explicit release or when the watch is no longer needed.
   */
  unwatch(containerId: ContainerId): void {
    const entry = this.watches.get(containerId)
    if (!entry) return

    this.watches.delete(containerId)

    // Clear the expiry timestamp in DB
    this.db
      .update(schema.containers)
      .set({ idleExpiresAt: null })
      .where(eq(schema.containers.containerId, containerId))
      .run()

    idleReaperWatchesActive.dec({ pool_id: entry.poolId })
    idleReaperFileWatchCount.remove({ pool_id: entry.poolId, container_id: containerId })

    // Stop the poll loop if no more watches
    if (this.watches.size === 0) {
      this.stopPollLoop()
    }
  }

  /**
   * Check if a container is being watched.
   */
  isWatching(containerId: ContainerId): boolean {
    return this.watches.has(containerId)
  }

  /**
   * Get the number of active watches.
   */
  get activeWatchCount(): number {
    return this.watches.size
  }

  /**
   * Restore watches for containers that were claimed before a restart.
   * Checks mtime of state directories and either releases immediately
   * (if idle through the restart) or starts watching with remaining TTL.
   */
  restoreFromDb(pools: ReadonlyMap<PoolId, ContainerPool>, manager: ContainerManager): void {
    for (const [poolId, pool] of pools) {
      const ttlMs = pool.getConfig().fileIdleTtl
      if (!ttlMs) continue

      // Find all claimed containers in this pool
      const claimedRows = this.db
        .select({
          containerId: schema.containers.containerId,
          tenantId: schema.containers.tenantId,
        })
        .from(schema.containers)
        .where(and(eq(schema.containers.poolId, poolId), eq(schema.containers.status, 'claimed')))
        .all()

      for (const row of claimedRows) {
        if (!row.tenantId) continue
        const tenantId = row.tenantId

        const stateDir = manager.getStateDir(row.containerId)
        const now = Date.now()

        try {
          const maxMtime = this.getMaxMtime(stateDir)
          const elapsed = now - maxMtime

          if (elapsed >= ttlMs) {
            // Container was idle through the restart — release immediately
            console.log(
              `[IdleReaper] Container ${row.containerId} was idle through restart, releasing`,
            )
            this.onExpiry(row.containerId, tenantId, poolId).catch((err) => {
              console.error(
                `[IdleReaper] Failed to release idle container ${row.containerId} on recovery:`,
                err,
              )
            })
          } else {
            // Start watching — set lastModified to the actual mtime so TTL is accurate
            const expiresAt = new Date(maxMtime + ttlMs)
            this.watches.set(row.containerId, {
              containerId: row.containerId,
              tenantId,
              poolId,
              stateDir,
              ttlMs,
              lastModified: maxMtime,
              dbUpdatePending: false,
            })
            this.db
              .update(schema.containers)
              .set({ idleExpiresAt: expiresAt })
              .where(eq(schema.containers.containerId, row.containerId))
              .run()
            idleReaperWatchesActive.inc({ pool_id: poolId })
          }
        } catch {
          // State dir doesn't exist or can't be stat'd — start fresh watch
          this.watch(row.containerId, tenantId, poolId, stateDir, ttlMs)
        }
      }
    }

    // Start poll loop if we restored any watches
    if (this.watches.size > 0) {
      this.ensurePollLoop()
    }
  }

  /**
   * Shut down all watches and stop the poll loop.
   */
  shutdown(): void {
    this.stopPollLoop()
    for (const entry of this.watches.values()) {
      idleReaperWatchesActive.dec({ pool_id: entry.poolId })
      idleReaperFileWatchCount.remove({
        pool_id: entry.poolId,
        container_id: entry.containerId,
      })
    }
    this.watches.clear()
  }

  /**
   * Start the shared poll loop if not already running.
   */
  private ensurePollLoop(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs)
  }

  /**
   * Stop the shared poll loop.
   */
  private stopPollLoop(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /**
   * Single poll iteration: check every watched container's state directory for mtime changes.
   */
  private poll(): void {
    const now = Date.now()
    // Snapshot keys to allow mutation during iteration
    const containerIds = [...this.watches.keys()]

    for (const containerId of containerIds) {
      const entry = this.watches.get(containerId)
      if (!entry) continue

      try {
        const { maxMtime, fileCount } = this.walkMtimes(entry.stateDir)

        idleReaperFileWatchCount.set(
          { pool_id: entry.poolId, container_id: containerId },
          fileCount,
        )

        if (maxMtime > entry.lastModified) {
          // Activity detected — reset TTL
          entry.lastModified = maxMtime
          idleReaperResets.inc({ pool_id: entry.poolId })

          // Debounced DB update (at most once per poll cycle)
          if (!entry.dbUpdatePending) {
            entry.dbUpdatePending = true
            const newExpiry = new Date(now + entry.ttlMs)
            // Use setTimeout so it doesn't block the poll loop
            setTimeout(() => {
              entry.dbUpdatePending = false
              this.db
                .update(schema.containers)
                .set({ lastActivity: new Date(), idleExpiresAt: newExpiry })
                .where(eq(schema.containers.containerId, containerId))
                .run()
            }, 0)
          }
        } else {
          // No activity — check if TTL has elapsed
          const elapsed = now - entry.lastModified
          if (elapsed >= entry.ttlMs) {
            this.handleExpiry(containerId)
          }
        }
      } catch {
        // State dir gone — treat as expired
        console.warn(`[IdleReaper] Cannot stat ${entry.stateDir} for ${containerId}, expiring`)
        this.handleExpiry(containerId)
      }
    }
  }

  /**
   * Walk a directory tree and return the maximum mtime and total entry count.
   */
  private walkMtimes(dir: string): { maxMtime: number; fileCount: number } {
    let maxMtime = 0
    let fileCount = 0

    const walk = (current: string) => {
      const st = statSync(current)
      fileCount++
      if (st.mtimeMs > maxMtime) {
        maxMtime = st.mtimeMs
      }
      if (st.isDirectory()) {
        try {
          const entries = readdirSync(current)
          for (const entry of entries) {
            walk(join(current, entry))
          }
        } catch {
          // Permission denied or dir disappeared mid-walk
        }
      }
    }

    walk(dir)
    return { maxMtime, fileCount }
  }

  /**
   * Get the maximum mtime across all files in a directory tree.
   */
  private getMaxMtime(dir: string): number {
    return this.walkMtimes(dir).maxMtime
  }

  private handleExpiry(containerId: ContainerId): void {
    const entry = this.watches.get(containerId)
    if (!entry) return

    const { tenantId, poolId } = entry

    console.log(
      `[IdleReaper] Container ${containerId} (tenant ${tenantId}) expired after ${entry.ttlMs}ms inactivity`,
    )

    idleReaperExpirations.inc({ pool_id: poolId })

    // Unwatch first so the release flow doesn't try to unwatch again
    this.unwatch(containerId)

    // Trigger the release flow
    this.onExpiry(containerId, tenantId, poolId).catch((err) => {
      console.error(`[IdleReaper] Failed to release expired container ${containerId}:`, err)
    })
  }
}
