/**
 * Activity Log
 *
 * In-memory activity log for tracking container and sync events.
 * Provides real-time event streaming via callbacks.
 */

import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'

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
 * Activity log configuration
 */
export interface ActivityLogConfig {
  maxEvents?: number
}

const DEFAULT_CONFIG: Required<ActivityLogConfig> = {
  maxEvents: 1000,
}

/**
 * In-memory activity log
 */
export class ActivityLog {
  private events: ActivityEvent[] = []
  private listeners: Set<ActivityEventListener> = new Set()
  private config: Required<ActivityLogConfig>
  private eventCounter = 0

  constructor(config?: ActivityLogConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
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
    const event: ActivityEvent = {
      id: `evt-${++this.eventCounter}`,
      type,
      message,
      timestamp: new Date().toISOString(),
      ...options,
    }

    this.events.unshift(event)

    // Trim old events
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(0, this.config.maxEvents)
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
    return this.events.slice(offset, offset + limit)
  }

  /**
   * Get events filtered by type
   */
  getEventsByType(type: ActivityEventType, limit = 50): ActivityEvent[] {
    return this.events.filter((e) => e.type === type).slice(0, limit)
  }

  /**
   * Get events for a specific tenant
   */
  getEventsForTenant(tenantId: TenantId, limit = 50): ActivityEvent[] {
    return this.events.filter((e) => e.tenantId === tenantId).slice(0, limit)
  }

  /**
   * Get events for a specific pool
   */
  getEventsForPool(poolId: PoolId, limit = 50): ActivityEvent[] {
    return this.events.filter((e) => e.poolId === poolId).slice(0, limit)
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
    this.events = []
    this.eventCounter = 0
  }

  /**
   * Get total event count
   */
  get count(): number {
    return this.events.length
  }
}

// Global activity log instance
let globalActivityLog: ActivityLog | null = null

/**
 * Get or create the global activity log
 */
export function getActivityLog(config?: ActivityLogConfig): ActivityLog {
  if (!globalActivityLog) {
    globalActivityLog = new ActivityLog(config)
  }
  return globalActivityLog
}

// Convenience logging functions
export function logContainerCreated(
  containerId: ContainerId,
  poolId: PoolId,
  log?: ActivityLog,
): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log('container.created', `Container ${containerId} created in pool ${poolId}`, {
    containerId,
    poolId,
  })
}

export function logContainerClaimed(
  containerId: ContainerId,
  tenantId: TenantId,
  poolId: PoolId,
  log?: ActivityLog,
): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log(
    'container.claimed',
    `Container ${containerId} claimed by tenant ${tenantId}`,
    { containerId, tenantId, poolId },
  )
}

export function logContainerReleased(
  containerId: ContainerId,
  tenantId: TenantId,
  poolId: PoolId,
  log?: ActivityLog,
): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log(
    'container.released',
    `Container ${containerId} released by tenant ${tenantId}`,
    { containerId, tenantId, poolId },
  )
}

export function logContainerDestroyed(
  containerId: ContainerId,
  poolId: PoolId,
  log?: ActivityLog,
): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log('container.destroyed', `Container ${containerId} destroyed`, {
    containerId,
    poolId,
  })
}

export function logSyncStarted(
  tenantId: TenantId,
  direction: string,
  log?: ActivityLog,
): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log('sync.started', `Sync started for tenant ${tenantId} (${direction})`, {
    tenantId,
    metadata: { direction },
  })
}

export function logSyncCompleted(
  tenantId: TenantId,
  bytesTransferred: number,
  log?: ActivityLog,
): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  const sizeStr = formatBytes(bytesTransferred)
  return activityLog.log('sync.completed', `Sync completed for tenant ${tenantId} (${sizeStr})`, {
    tenantId,
    metadata: { bytesTransferred },
  })
}

export function logSyncFailed(tenantId: TenantId, error: string, log?: ActivityLog): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log('sync.failed', `Sync failed for tenant ${tenantId}: ${error}`, {
    tenantId,
    metadata: { error },
  })
}

export function logPoolCreated(poolId: PoolId, workloadId: string, log?: ActivityLog): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log('pool.created', `Pool ${poolId} created for workload ${workloadId}`, {
    poolId,
    metadata: { workloadId },
  })
}

export function logPoolScaled(
  poolId: PoolId,
  previousSize: number,
  newSize: number,
  log?: ActivityLog,
): ActivityEvent {
  const activityLog = log ?? getActivityLog()
  return activityLog.log(
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
