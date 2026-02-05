/**
 * API client for the Boilerhouse dashboard
 */

import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import type {
  ActivityEvent,
  ContainerInfo,
  DashboardStats,
  PoolInfo,
  PoolMetrics,
  SyncJobInfo,
  SyncSpecInfo,
  TenantInfo,
} from './types'

const API_BASE = '/api/v1'

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    throw new ApiError(response.status, error.message || response.statusText)
  }

  return response.json()
}

// =============================================================================
// Dashboard
// =============================================================================

export async function getStats(): Promise<DashboardStats> {
  return fetchApi<DashboardStats>('/stats')
}

export async function getActivity(limit = 50): Promise<ActivityEvent[]> {
  return fetchApi<ActivityEvent[]>(`/activity?limit=${limit}`)
}

// =============================================================================
// Pools
// =============================================================================

export async function getPools(): Promise<PoolInfo[]> {
  return fetchApi<PoolInfo[]>('/pools')
}

export async function getPool(poolId: PoolId): Promise<PoolInfo> {
  return fetchApi<PoolInfo>(`/pools/${poolId}`)
}

export async function getPoolMetrics(poolId: PoolId): Promise<PoolMetrics> {
  return fetchApi<PoolMetrics>(`/pools/${poolId}/metrics`)
}

export async function scalePool(poolId: PoolId, targetSize: number): Promise<void> {
  await fetchApi(`/pools/${poolId}/scale`, {
    method: 'POST',
    body: JSON.stringify({ targetSize }),
  })
}

// =============================================================================
// Containers
// =============================================================================

export async function getContainers(poolId?: PoolId): Promise<ContainerInfo[]> {
  const query = poolId ? `?poolId=${poolId}` : ''
  return fetchApi<ContainerInfo[]>(`/containers${query}`)
}

export async function getContainer(containerId: ContainerId): Promise<ContainerInfo> {
  return fetchApi<ContainerInfo>(`/containers/${containerId}`)
}

export async function destroyContainer(containerId: ContainerId): Promise<void> {
  await fetchApi(`/containers/${containerId}`, { method: 'DELETE' })
}

// =============================================================================
// Tenants
// =============================================================================

export async function getTenants(): Promise<TenantInfo[]> {
  return fetchApi<TenantInfo[]>('/tenants')
}

export async function getTenant(tenantId: TenantId): Promise<TenantInfo> {
  return fetchApi<TenantInfo>(`/tenants/${tenantId}`)
}

export async function claimContainer(
  tenantId: TenantId,
  poolId: PoolId,
): Promise<{ containerId: ContainerId }> {
  return fetchApi<{ containerId: ContainerId }>(`/tenants/${tenantId}/claim`, {
    method: 'POST',
    body: JSON.stringify({ poolId }),
  })
}

export async function releaseContainer(tenantId: TenantId, sync = true): Promise<void> {
  await fetchApi(`/tenants/${tenantId}/release`, {
    method: 'POST',
    body: JSON.stringify({ sync }),
  })
}

export async function triggerSync(
  tenantId: TenantId,
  direction: 'upload' | 'download' | 'both' = 'both',
): Promise<void> {
  await fetchApi(`/tenants/${tenantId}/sync`, {
    method: 'POST',
    body: JSON.stringify({ direction }),
  })
}

// =============================================================================
// Sync
// =============================================================================

export async function getSyncSpecs(): Promise<SyncSpecInfo[]> {
  return fetchApi<SyncSpecInfo[]>('/sync-specs')
}

export async function getSyncJobs(status?: string): Promise<SyncJobInfo[]> {
  const query = status ? `?status=${status}` : ''
  return fetchApi<SyncJobInfo[]>(`/sync/jobs${query}`)
}

export async function getSyncHistory(tenantId?: TenantId, limit = 50): Promise<SyncJobInfo[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (tenantId) params.set('tenantId', tenantId)
  return fetchApi<SyncJobInfo[]>(`/sync/history?${params}`)
}

// =============================================================================
// Export as namespace for cleaner imports
// =============================================================================

export const api = {
  getStats,
  getActivity,
  getPools,
  getPool,
  getPoolMetrics,
  scalePool,
  getContainers,
  getContainer,
  destroyContainer,
  getTenants,
  getTenant,
  claimContainer,
  releaseContainer,
  triggerSync,
  getSyncSpecs,
  getSyncJobs,
  getSyncHistory,
}
