import { api } from '@/api'
import type {
  ActivityEvent,
  ContainerInfo,
  DashboardStats,
  PoolInfo,
  PoolMetrics,
  SyncJobInfo,
  TenantInfo,
  WorkloadInfo,
} from '@/api/types'
import type { ContainerId, PoolId, TenantId } from '@boilerhouse/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

// =============================================================================
// Query Keys
// =============================================================================

export const queryKeys = {
  stats: ['stats'] as const,
  activity: (limit?: number) => ['activity', limit] as const,
  workloads: ['workloads'] as const,
  pools: ['pools'] as const,
  pool: (id: PoolId) => ['pools', id] as const,
  poolMetrics: (id: PoolId) => ['pools', id, 'metrics'] as const,
  containers: (poolId?: PoolId) => ['containers', poolId] as const,
  container: (id: ContainerId) => ['containers', id] as const,
  tenants: ['tenants'] as const,
  tenant: (id: TenantId) => ['tenants', id] as const,
  syncJobs: (status?: string) => ['sync', 'jobs', status] as const,
  syncHistory: (tenantId?: TenantId, limit?: number) =>
    ['sync', 'history', tenantId, limit] as const,
}

// =============================================================================
// Dashboard Queries
// =============================================================================

export function useStats() {
  return useQuery<DashboardStats>({
    queryKey: queryKeys.stats,
    queryFn: api.getStats,
  })
}

export function useActivity(limit = 50) {
  return useQuery<ActivityEvent[]>({
    queryKey: queryKeys.activity(limit),
    queryFn: () => api.getActivity(limit),
  })
}

// =============================================================================
// Workload Queries
// =============================================================================

export function useWorkloads() {
  return useQuery<WorkloadInfo[]>({
    queryKey: queryKeys.workloads,
    queryFn: api.getWorkloads,
  })
}

// =============================================================================
// Pool Queries
// =============================================================================

export function usePools() {
  return useQuery<PoolInfo[]>({
    queryKey: queryKeys.pools,
    queryFn: api.getPools,
  })
}

export function usePool(poolId: PoolId) {
  return useQuery<PoolInfo>({
    queryKey: queryKeys.pool(poolId),
    queryFn: () => api.getPool(poolId),
    enabled: !!poolId,
  })
}

export function usePoolMetrics(poolId: PoolId) {
  return useQuery<PoolMetrics>({
    queryKey: queryKeys.poolMetrics(poolId),
    queryFn: () => api.getPoolMetrics(poolId),
    enabled: !!poolId,
  })
}

export function useScalePool() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ poolId, targetSize }: { poolId: PoolId; targetSize: number }) =>
      api.scalePool(poolId, targetSize),
    onSuccess: (_, { poolId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pool(poolId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.pools })
      queryClient.invalidateQueries({ queryKey: queryKeys.containers(poolId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.stats })
    },
  })
}

export function useCreatePool() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      poolId,
      workloadId,
      minIdle,
      maxSize,
    }: {
      poolId: string
      workloadId: string
      minIdle?: number
      maxSize?: number
    }) => api.createPool(poolId, workloadId, { minIdle, maxSize }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pools })
      queryClient.invalidateQueries({ queryKey: queryKeys.stats })
    },
  })
}

// =============================================================================
// Container Queries
// =============================================================================

export function useContainers(poolId?: PoolId) {
  return useQuery<ContainerInfo[]>({
    queryKey: queryKeys.containers(poolId),
    queryFn: () => api.getContainers(poolId),
  })
}

export function useContainer(containerId: ContainerId) {
  return useQuery<ContainerInfo>({
    queryKey: queryKeys.container(containerId),
    queryFn: () => api.getContainer(containerId),
    enabled: !!containerId,
  })
}

export function useDestroyContainer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (containerId: ContainerId) => api.destroyContainer(containerId),
    onSuccess: () => {
      // Invalidate all container and pool queries
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'containers' })
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'pools' })
      queryClient.invalidateQueries({ queryKey: queryKeys.stats })
    },
  })
}

// =============================================================================
// Tenant Queries
// =============================================================================

export function useTenants() {
  return useQuery<TenantInfo[]>({
    queryKey: queryKeys.tenants,
    queryFn: api.getTenants,
  })
}

export function useTenant(tenantId: TenantId) {
  return useQuery<TenantInfo>({
    queryKey: queryKeys.tenant(tenantId),
    queryFn: () => api.getTenant(tenantId),
    enabled: !!tenantId,
  })
}

export function useClaimContainer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tenantId, poolId }: { tenantId: TenantId; poolId: PoolId }) =>
      api.claimContainer(tenantId, poolId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants })
      queryClient.invalidateQueries({ queryKey: queryKeys.pools })
      queryClient.invalidateQueries({ queryKey: queryKeys.stats })
    },
  })
}

export function useReleaseContainer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tenantId, sync }: { tenantId: TenantId; sync?: boolean }) =>
      api.releaseContainer(tenantId, sync),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants })
      queryClient.invalidateQueries({ queryKey: queryKeys.pools })
      queryClient.invalidateQueries({ queryKey: queryKeys.stats })
    },
  })
}

export function useTriggerSync() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      tenantId,
      direction,
    }: {
      tenantId: TenantId
      direction?: 'upload' | 'download' | 'both'
    }) => api.triggerSync(tenantId, direction),
    onSuccess: (_, { tenantId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenant(tenantId) })
      queryClient.invalidateQueries({ queryKey: ['sync'] })
    },
  })
}

// =============================================================================
// Sync Queries
// =============================================================================

export function useSyncJobs(status?: string) {
  return useQuery<SyncJobInfo[]>({
    queryKey: queryKeys.syncJobs(status),
    queryFn: () => api.getSyncJobs(status),
  })
}

export function useSyncHistory(tenantId?: TenantId, limit = 50) {
  return useQuery<SyncJobInfo[]>({
    queryKey: queryKeys.syncHistory(tenantId, limit),
    queryFn: () => api.getSyncHistory(tenantId, limit),
  })
}
