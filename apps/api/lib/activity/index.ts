/**
 * Activity Log
 *
 * Activity log for tracking container and sync events.
 * All state stored in ActivityRepository (DB as source of truth).
 * Provides real-time event streaming via callbacks.
 */

import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import type { ActivityRepository } from '@boilerhouse/db'

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

/**
 * Activity log backed by SQLite
 */
export class ActivityLog {
  private listeners: Set<ActivityEventListener> = new Set()
  private activityRepo: ActivityRepository

  constructor(activityRepo: ActivityRepository) {
    this.activityRepo = activityRepo
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
    const id = this.activityRepo.save({
      eventType: type,
      poolId: options?.poolId ?? null,
      containerId: options?.containerId ?? null,
      tenantId: options?.tenantId ?? null,
      message,
      metadata: options?.metadata ?? null,
      timestamp: now,
    })

    const event: ActivityEvent = {
      id: `evt-${id}`,
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
    const entries = this.activityRepo.findRecent(limit, offset)
    return entries.map((entry) => this.entryToEvent(entry))
  }

  /**
   * Get events filtered by type
   */
  getEventsByType(type: ActivityEventType, limit = 50): ActivityEvent[] {
    const entries = this.activityRepo.findByType(type, limit)
    return entries.map((entry) => this.entryToEvent(entry))
  }

  /**
   * Get events for a specific tenant
   */
  getEventsForTenant(tenantId: TenantId, limit = 50): ActivityEvent[] {
    const entries = this.activityRepo.findByTenant(tenantId, limit)
    return entries.map((entry) => this.entryToEvent(entry))
  }

  /**
   * Get events for a specific pool
   */
  getEventsForPool(poolId: PoolId, limit = 50): ActivityEvent[] {
    const entries = this.activityRepo.findByPool(poolId, limit)
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
    this.activityRepo.clear()
  }

  /**
   * Get total event count
   */
  get count(): number {
    return this.activityRepo.count()
  }

  private entryToEvent(entry: {
    id?: number
    eventType: string
    poolId: PoolId | null
    containerId: ContainerId | null
    tenantId: TenantId | null
    message: string
    metadata: Record<string, unknown> | null
    timestamp: Date
  }): ActivityEvent {
    return {
      id: `evt-${entry.id ?? 0}`,
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
