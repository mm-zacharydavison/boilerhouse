/**
 * Mock data for dashboard development
 * This is used when the API is not available
 */

import { ContainerId, PoolId, SyncId, TenantId, WorkloadId } from '@boilerhouse/core'

import type {
  ActivityEvent,
  ContainerInfo,
  DashboardStats,
  PoolInfo,
  SyncJobInfo,
  TenantInfo,
} from '@/api/types'

export const mockStats: DashboardStats = {
  totalPools: 3,
  totalContainers: 45,
  activeContainers: 23,
  idleContainers: 22,
  totalTenants: 23,
  syncStatus: {
    healthy: 20,
    warning: 2,
    error: 1,
  },
}

export const mockPools: PoolInfo[] = [
  {
    id: PoolId('prod-workers'),
    workloadId: WorkloadId('python-worker'),
    workloadName: 'Python Worker',
    image: 'myregistry/python-worker:latest',
    minIdle: 5,
    maxSize: 25,
    currentSize: 20,
    claimedCount: 18,
    idleCount: 2,
    status: 'healthy',
    createdAt: '2024-01-15T10:00:00Z',
  },
  {
    id: PoolId('dev-sandbox'),
    workloadId: WorkloadId('sandbox'),
    workloadName: 'Dev Sandbox',
    image: 'myregistry/sandbox:v2',
    minIdle: 2,
    maxSize: 10,
    currentSize: 5,
    claimedCount: 2,
    idleCount: 3,
    status: 'healthy',
    createdAt: '2024-01-20T08:30:00Z',
  },
  {
    id: PoolId('ml-workers'),
    workloadId: WorkloadId('pytorch-gpu'),
    workloadName: 'PyTorch GPU',
    image: 'myregistry/pytorch-gpu:latest',
    minIdle: 3,
    maxSize: 15,
    currentSize: 10,
    claimedCount: 3,
    idleCount: 7,
    status: 'degraded',
    createdAt: '2024-02-01T14:00:00Z',
  },
]

export const mockContainers: ContainerInfo[] = [
  {
    id: ContainerId('c-abc12345'),
    poolId: PoolId('prod-workers'),
    tenantId: TenantId('tenant-001'),
    status: 'claimed',
    workloadId: WorkloadId('python-worker'),
    workloadName: 'Python Worker',
    image: 'myregistry/python-worker:latest',
    createdAt: '2024-02-05T08:00:00Z',
    lastActivityAt: '2024-02-05T11:30:00Z',
    idleExpiresAt: null,
    cpuUsagePercent: 45,
    memoryUsageMb: 256,
  },
  {
    id: ContainerId('c-def67890'),
    poolId: PoolId('prod-workers'),
    tenantId: null,
    status: 'idle',
    workloadId: WorkloadId('python-worker'),
    workloadName: 'Python Worker',
    image: 'myregistry/python-worker:latest',
    createdAt: '2024-02-05T08:15:00Z',
    lastActivityAt: '2024-02-05T10:00:00Z',
    idleExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    cpuUsagePercent: 0,
    memoryUsageMb: 64,
  },
  {
    id: ContainerId('c-ghi11111'),
    poolId: PoolId('dev-sandbox'),
    tenantId: TenantId('tenant-002'),
    status: 'claimed',
    workloadId: WorkloadId('sandbox'),
    workloadName: 'Dev Sandbox',
    image: 'myregistry/sandbox:v2',
    createdAt: '2024-02-05T09:00:00Z',
    lastActivityAt: '2024-02-05T11:45:00Z',
    idleExpiresAt: null,
    cpuUsagePercent: 12,
    memoryUsageMb: 128,
  },
]

export const mockTenants: TenantInfo[] = [
  {
    id: TenantId('tenant-001'),
    poolId: PoolId('prod-workers'),
    containerId: ContainerId('c-abc12345'),
    status: 'active',
    claimedAt: '2024-02-05T08:05:00Z',
    lastActivityAt: '2024-02-05T11:30:00Z',
    syncStatus: {
      syncId: SyncId('sync-001'),
      tenantId: TenantId('tenant-001'),
      lastSyncAt: new Date('2024-02-05T11:25:00Z'),
      pendingCount: 0,
      errors: [],
      state: 'idle',
    },
  },
  {
    id: TenantId('tenant-002'),
    poolId: PoolId('dev-sandbox'),
    containerId: ContainerId('c-ghi11111'),
    status: 'active',
    claimedAt: '2024-02-05T09:10:00Z',
    lastActivityAt: '2024-02-05T11:45:00Z',
    syncStatus: {
      syncId: SyncId('sync-002'),
      tenantId: TenantId('tenant-002'),
      lastSyncAt: new Date('2024-02-05T11:40:00Z'),
      pendingCount: 2,
      errors: [],
      state: 'syncing',
    },
  },
  {
    id: TenantId('tenant-003'),
    poolId: null,
    containerId: null,
    status: 'idle',
    claimedAt: null,
    lastActivityAt: '2024-02-04T16:00:00Z',
    syncStatus: null,
  },
]

export const mockActivity: ActivityEvent[] = [
  {
    id: 'evt-001',
    type: 'container.claimed',
    poolId: PoolId('prod-workers'),
    containerId: ContainerId('c-abc12345'),
    tenantId: TenantId('tenant-001'),
    message: 'Container c-abc12345 claimed by tenant-001',
    timestamp: '2024-02-05T11:32:01Z',
  },
  {
    id: 'evt-002',
    type: 'sync.completed',
    tenantId: TenantId('tenant-002'),
    message: 'Sync completed for tenant-002 (1.2 MB uploaded)',
    timestamp: '2024-02-05T11:31:45Z',
    metadata: { bytesTransferred: 1258291 },
  },
  {
    id: 'evt-003',
    type: 'container.released',
    poolId: PoolId('prod-workers'),
    containerId: ContainerId('c-xyz99999'),
    tenantId: TenantId('tenant-005'),
    message: 'Container c-xyz99999 released by tenant-005',
    timestamp: '2024-02-05T11:30:22Z',
  },
  {
    id: 'evt-004',
    type: 'pool.scaled',
    poolId: PoolId('ml-workers'),
    message: 'Pool ml-workers scaled up (8 to 10 containers)',
    timestamp: '2024-02-05T11:29:58Z',
    metadata: { previousSize: 8, newSize: 10 },
  },
  {
    id: 'evt-005',
    type: 'sync.failed',
    tenantId: TenantId('tenant-010'),
    message: 'Sync failed for tenant-010: Connection timeout',
    timestamp: '2024-02-05T11:28:00Z',
    metadata: { error: 'Connection timeout after 30s' },
  },
]

export const mockSyncJobs: SyncJobInfo[] = [
  {
    id: 'job-001',
    tenantId: TenantId('tenant-002'),
    poolId: PoolId('dev-sandbox'),
    direction: 'upload',
    status: 'running',
    progress: 65,
    bytesTransferred: 845000,
    startedAt: '2024-02-05T11:44:00Z',
  },
  {
    id: 'job-002',
    tenantId: TenantId('tenant-001'),
    poolId: PoolId('prod-workers'),
    direction: 'bidirectional',
    status: 'completed',
    progress: 100,
    bytesTransferred: 1258291,
    startedAt: '2024-02-05T11:30:00Z',
    completedAt: '2024-02-05T11:31:45Z',
  },
  {
    id: 'job-003',
    tenantId: TenantId('tenant-010'),
    poolId: PoolId('prod-workers'),
    direction: 'upload',
    status: 'failed',
    startedAt: '2024-02-05T11:27:00Z',
    completedAt: '2024-02-05T11:28:00Z',
    error: 'Connection timeout after 30s',
  },
]
