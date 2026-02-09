/**
 * API types for the dashboard
 * These extend/complement the core types with API-specific structures
 */

import type {
  ContainerId,
  ContainerInfo as CoreContainerInfo,
  PoolId,
  PoolInfo,
  TenantId,
  TenantInfo,
  WorkloadId,
} from '@boilerhouse/core'

export type { PoolInfo, TenantInfo }

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

export interface ContainerInfo extends CoreContainerInfo {
  cpuUsagePercent?: number
  memoryUsageMb?: number
}

// =============================================================================
// Tenant Types (TenantInfo re-exported from @boilerhouse/core)
// =============================================================================

// =============================================================================
// Sync Types
// =============================================================================

export interface SyncJobInfo {
  id: string
  tenantId: TenantId
  poolId: PoolId
  direction: 'upload' | 'download'
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
