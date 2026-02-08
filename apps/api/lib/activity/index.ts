/**
 * Activity Log
 *
 * Activity log for tracking container and sync events.
 * All state stored in SQLite via Drizzle ORM (DB as source of truth).
 * Provides real-time event streaming via callbacks.
 */

import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import { type DrizzleDb, schema } from '@boilerhouse/db'
import { count, desc, eq, notInArray } from 'drizzle-orm'

/**
 * Activity event types
 */
export type ActivityEventType =
  | 'container.created'
  | 'container.claimed'
  | 'container.released'
  | 'container.destroyed'
  | 'container.unhealthy'
  | 'sync.started'
  | 'sync.completed'
  | 'sync.failed'
  | 'pool.created'
  | 'pool.scaled'
  | 'pool.destroyed'
  | 'pool.warning'
  | 'hook.started'
  | 'hook.completed'
  | 'hook.failed'

/**
 * Activity event
 */
export interface ActivityEvent {
  id: string
  type: ActivityEventType
  poolId?: PoolId
  containerId?: ContainerId
  tenantId?: TenantId
  message: string
  timestamp: string
  metadata?: Record<string, unknown>
}

/**
 * Activity event listener
 */
export type ActivityEventListener = (event: ActivityEvent) => void

const DEFAULT_MAX_EVENTS = 1000

/**
 * Activity log backed by SQLite
 */
export class ActivityLog {
  private listeners: Set<ActivityEventListener> = new Set()
  private db: DrizzleDb
  private maxEvents: number

  constructor(db: DrizzleDb, maxEvents = DEFAULT_MAX_EVENTS) {
    this.db = db
    this.maxEvents = maxEvents
  }

  /**
   * Log a new activity event
   */
  log(
    type: ActivityEventType,
    message: string,
    options?: {
      poolId?: PoolId
      containerId?: ContainerId
      tenantId?: TenantId
      metadata?: Record<string, unknown>
    },
  ): ActivityEvent {
    const now = new Date()

    // Persist to database
    const [inserted] = this.db
      .insert(schema.activityLog)
      .values({
        eventType: type,
        poolId: options?.poolId ?? null,
        containerId: options?.containerId ?? null,
        tenantId: options?.tenantId ?? null,
        message,
        metadata: options?.metadata ?? null,
        timestamp: now,
      })
      .returning({ id: schema.activityLog.id })
      .all()

    const insertedId = inserted.id

    // Auto-trim periodically
    if (insertedId % 100 === 0) {
      this.trim()
    }

    const event: ActivityEvent = {
      id: `evt-${insertedId}`,
      type,
      message,
      timestamp: now.toISOString(),
      ...options,
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Activity listener error:', error)
      }
    }

    return event
  }

  /**
   * Get recent events
   */
  getEvents(limit = 50, offset = 0): ActivityEvent[] {
    const entries = this.db
      .select()
      .from(schema.activityLog)
      .orderBy(desc(schema.activityLog.timestamp))
      .limit(limit)
      .offset(offset)
      .all()
    return entries.map((entry) => this.entryToEvent(entry))
  }

  /**
   * Get events filtered by type
   */
  getEventsByType(type: ActivityEventType, limit = 50): ActivityEvent[] {
    const entries = this.db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.eventType, type))
      .orderBy(desc(schema.activityLog.timestamp))
      .limit(limit)
      .all()
    return entries.map((entry) => this.entryToEvent(entry))
  }

  /**
   * Get events for a specific tenant
   */
  getEventsForTenant(tenantId: TenantId, limit = 50): ActivityEvent[] {
    const entries = this.db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.tenantId, tenantId))
      .orderBy(desc(schema.activityLog.timestamp))
      .limit(limit)
      .all()
    return entries.map((entry) => this.entryToEvent(entry))
  }

  /**
   * Get events for a specific pool
   */
  getEventsForPool(poolId: PoolId, limit = 50): ActivityEvent[] {
    const entries = this.db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.poolId, poolId))
      .orderBy(desc(schema.activityLog.timestamp))
      .limit(limit)
      .all()
    return entries.map((entry) => this.entryToEvent(entry))
  }

  /**
   * Subscribe to activity events
   */
  subscribe(listener: ActivityEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.db.delete(schema.activityLog).run()
  }

  /**
   * Get total event count
   */
  get count(): number {
    const result = this.db.select({ count: count() }).from(schema.activityLog).get()
    return result?.count ?? 0
  }

  /**
   * Trim old events to keep only maxEvents.
   */
  private trim(): void {
    const keepIds = this.db
      .select({ id: schema.activityLog.id })
      .from(schema.activityLog)
      .orderBy(desc(schema.activityLog.timestamp))
      .limit(this.maxEvents)
      .all()
      .map((r) => r.id)

    if (keepIds.length === 0) {
      this.db.delete(schema.activityLog).run()
      return
    }

    this.db.delete(schema.activityLog).where(notInArray(schema.activityLog.id, keepIds)).run()
  }

  private entryToEvent(entry: typeof schema.activityLog.$inferSelect): ActivityEvent {
    return {
      id: `evt-${entry.id}`,
      type: entry.eventType as ActivityEventType,
      message: entry.message,
      timestamp: entry.timestamp.toISOString(),
      poolId: entry.poolId ?? undefined,
      containerId: entry.containerId ?? undefined,
      tenantId: entry.tenantId ?? undefined,
      metadata: entry.metadata ?? undefined,
    }
  }
}

// Convenience logging functions
export function logContainerCreated(
  containerId: ContainerId,
  poolId: PoolId,
  log: ActivityLog,
): ActivityEvent {
  return log.log('container.created', `Container ${containerId} created in pool ${poolId}`, {
    containerId,
    poolId,
  })
}

export function logContainerClaimed(
  containerId: ContainerId,
  tenantId: TenantId,
  poolId: PoolId,
  log: ActivityLog,
): ActivityEvent {
  return log.log('container.claimed', `Container ${containerId} claimed by tenant ${tenantId}`, {
    containerId,
    tenantId,
    poolId,
  })
}

export function logContainerReleased(
  containerId: ContainerId,
  tenantId: TenantId,
  poolId: PoolId,
  log: ActivityLog,
): ActivityEvent {
  return log.log('container.released', `Container ${containerId} released by tenant ${tenantId}`, {
    containerId,
    tenantId,
    poolId,
  })
}

export function logContainerDestroyed(
  containerId: ContainerId,
  poolId: PoolId,
  log: ActivityLog,
): ActivityEvent {
  return log.log('container.destroyed', `Container ${containerId} destroyed`, {
    containerId,
    poolId,
  })
}

export function logSyncStarted(
  tenantId: TenantId,
  direction: string,
  log: ActivityLog,
): ActivityEvent {
  return log.log('sync.started', `Sync started for tenant ${tenantId} (${direction})`, {
    tenantId,
    metadata: { direction },
  })
}

export function logSyncCompleted(
  tenantId: TenantId,
  bytesTransferred: number,
  log: ActivityLog,
): ActivityEvent {
  const sizeStr = formatBytes(bytesTransferred)
  return log.log('sync.completed', `Sync completed for tenant ${tenantId} (${sizeStr})`, {
    tenantId,
    metadata: { bytesTransferred },
  })
}

export function logSyncFailed(tenantId: TenantId, error: string, log: ActivityLog): ActivityEvent {
  return log.log('sync.failed', `Sync failed for tenant ${tenantId}: ${error}`, {
    tenantId,
    metadata: { error },
  })
}

export function logPoolCreated(
  poolId: PoolId,
  workloadId: string,
  log: ActivityLog,
): ActivityEvent {
  return log.log('pool.created', `Pool ${poolId} created for workload ${workloadId}`, {
    poolId,
    metadata: { workloadId },
  })
}

export function logPoolScaled(
  poolId: PoolId,
  previousSize: number,
  newSize: number,
  log: ActivityLog,
): ActivityEvent {
  return log.log(
    'pool.scaled',
    `Pool ${poolId} scaled from ${previousSize} to ${newSize} containers`,
    { poolId, metadata: { previousSize, newSize } },
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
