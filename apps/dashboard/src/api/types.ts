/**
 * API types for the dashboard
 * These extend/complement the core types with API-specific structures
 */

import type {
  ContainerId,
  ContainerStatus,
  PoolId,
  SyncStatus,
  TenantId,
  WorkloadId,
} from '@boilerhouse/core'

// =============================================================================
// Dashboard Stats
// =============================================================================

export interface DashboardStats {
  totalPools: number
  totalContainers: number
  activeContainers: number
  idleContainers: number
  totalTenants: number
  syncStatus: {
    healthy: number
    warning: number
    error: number
  }
}

// =============================================================================
// Workload Types
// =============================================================================

export interface WorkloadInfo {
  id: WorkloadId
  name: string
  image: string
}

// =============================================================================
// Pool Types
// =============================================================================

export interface PoolInfo {
  id: PoolId
  workloadId: WorkloadId
  workloadName: string
  image: string
  minIdle: number
  maxSize: number
  currentSize: number
  claimedCount: number
  idleCount: number
  status: 'healthy' | 'degraded' | 'error'
  createdAt: string
  lastError?: {
    message: string
    timestamp: string
  }
}

export interface PoolMetrics {
  poolId: PoolId
  cpuUsagePercent: number
  memoryUsagePercent: number
  claimLatencyMs: number
  releaseLatencyMs: number
  containersCreated24h: number
  containersDestroyed24h: number
}

// =============================================================================
// Container Types
// =============================================================================

export interface ContainerInfo {
  id: ContainerId
  poolId: PoolId
  tenantId: TenantId | null
  status: ContainerStatus
  workloadId: WorkloadId
  workloadName: string
  image: string
  createdAt: string
  lastActivityAt: string
  idleExpiresAt: string | null
  cpuUsagePercent?: number
  memoryUsageMb?: number
}

// =============================================================================
// Tenant Types
// =============================================================================

export interface TenantInfo {
  id: TenantId
  poolId: PoolId | null
  containerId: ContainerId | null
  status: 'active' | 'warm' | 'pending' | 'provisioning' | 'releasing' | 'idle' | 'cold'
  claimedAt: string | null
  lastActivityAt: string | null
  syncStatus: SyncStatus | null
}

// =============================================================================
// Sync Types
// =============================================================================

export interface SyncJobInfo {
  id: string
  tenantId: TenantId
  poolId: PoolId
  direction: 'upload' | 'download' | 'bidirectional'
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress?: number
  bytesTransferred?: number
  startedAt: string
  completedAt?: string
  error?: string
}

export interface SyncSpecInfo {
  id: string
  poolId: PoolId
  mappings: Array<{
    containerPath: string
    sinkPath: string
    direction: 'upload' | 'download' | 'bidirectional'
  }>
  sink: {
    type: 's3'
    bucket: string
    region: string
    prefix: string
  }
  policy: {
    onClaim: boolean
    onRelease: boolean
    intervalMs?: number
  }
}

// =============================================================================
// Activity Types
// =============================================================================

export interface ActivityEvent {
  id: string
  type:
    | 'container.created'
    | 'container.claimed'
    | 'container.released'
    | 'container.destroyed'
    | 'container.unhealthy'
    | 'sync.started'
    | 'sync.completed'
    | 'sync.failed'
    | 'pool.scaled'
    | 'pool.warning'
  poolId?: PoolId
  containerId?: ContainerId
  tenantId?: TenantId
  message: string
  timestamp: string
  metadata?: Record<string, unknown>
}

// =============================================================================
// WebSocket Events
// =============================================================================

export type WebSocketEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'stats'; data: DashboardStats }
  | { type: 'activity'; data: ActivityEvent }
  | { type: 'pool.update'; data: PoolInfo }
  | { type: 'container.update'; data: ContainerInfo }
  | { type: 'sync.update'; data: SyncJobInfo }
