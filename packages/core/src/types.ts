/**
 * Core types for the Boilerhouse container pool orchestrator
 *
 * TypeScript code uses camelCase per JS conventions.
 * YAML files use snake_case for docker-compose compatibility.
 * Conversion happens at the loader boundary.
 */

import type { CamelCasedPropertiesDeep } from 'type-fest'
import type { z } from 'zod'
import type {
  deployConfigSchema,
  healthCheckConfigSchema,
  poolConfigSchema,
  resourceLimitsSchema,
  resourcesConfigSchema,
  s3SinkConfigSchema,
  securityConfigSchema,
  sinkConfigSchema,
  volumeConfigSchema,
  workloadSpecSchema,
  workloadSyncConfigSchema,
  workloadSyncMappingSchema,
  workloadSyncPolicySchema,
} from './schemas/workload'

// =============================================================================
// Branded ID Types
// =============================================================================

/**
 * Unique identifier for a tenant (user/organization).
 * @example 'tenant-12345'
 * @example 'org_abc123'
 */
export type TenantId = string

/**
 * Unique identifier for a container instance.
 * @example 'ml7wk37p-vbjcpb5g'
 */
export type ContainerId = string

/**
 * Unique identifier for a workload specification.
 * @example 'python-worker'
 * @example 'node-api'
 */
export type WorkloadId = string

/**
 * Unique identifier for a container pool.
 * @example 'prod-workers'
 * @example 'dev-sandbox'
 */
export type PoolId = string

/**
 * Unique identifier for a sync specification.
 * @example 'worker-state-sync'
 */
export type SyncId = string

/**
 * Key identifying a session, typically channel:userId format.
 * @example 'api:user-12345'
 * @example 'ws:session-uuid'
 */
export type SessionKey = string

// =============================================================================
// Container Types
// =============================================================================

/**
 * Lifecycle status of a container.
 * - `idle`: Container is pre-warmed and available for claiming
 * - `claimed`: Container is claimed by a tenant and processing requests
 * - `stopping`: Container is being stopped or released
 */
export type ContainerStatus = 'idle' | 'claimed' | 'stopping'

/**
 * Represents a running container instance in the pool.
 */
export interface PoolContainer {
  /** Unique identifier for this container. */
  containerId: ContainerId
  /** ID of the tenant that claimed this container. Null when pre-warmed and unclaimed. */
  tenantId: TenantId | null
  /** ID of the pool this container belongs to. */
  poolId: PoolId
  /** Path to the Unix socket for communicating with the container. */
  socketPath: string
  /** Host path to the container's mounted state directory. */
  stateDir: string
  /** Host path to the container's mounted secrets directory. */
  secretsDir: string
  /** Timestamp of the last activity on this container. */
  lastActivity: Date
  /** Current lifecycle status of the container. */
  status: ContainerStatus
  /** Previous tenant ID, preserved after release for affinity matching. */
  lastTenantId?: TenantId | null
  /** When this idle container will be evicted. */
  idleExpiresAt?: Date | null
}

// =============================================================================
// Raw Workload Types (snake_case, directly from Zod schema / YAML)
// =============================================================================

/** Raw volume config from YAML (snake_case). */
export type VolumeConfigRaw = z.infer<typeof volumeConfigSchema>

/** Raw health check config from YAML (snake_case). */
export type HealthCheckConfigRaw = z.infer<typeof healthCheckConfigSchema>

/** Raw resource limits from YAML (snake_case). */
export type ResourceLimitsRaw = z.infer<typeof resourceLimitsSchema>

/** Raw resources config from YAML (snake_case). */
export type ResourcesConfigRaw = z.infer<typeof resourcesConfigSchema>

/** Raw deploy config from YAML (snake_case). */
export type DeployConfigRaw = z.infer<typeof deployConfigSchema>

/** Raw security config from YAML (snake_case). */
export type SecurityConfigRaw = z.infer<typeof securityConfigSchema>

/** Raw pool config from YAML (snake_case). */
export type PoolConfigRaw = z.infer<typeof poolConfigSchema>

/** Raw sync mapping from YAML (snake_case). */
export type WorkloadSyncMappingRaw = z.infer<typeof workloadSyncMappingSchema>

/** Raw sync policy from YAML (snake_case). */
export type WorkloadSyncPolicyRaw = z.infer<typeof workloadSyncPolicySchema>

/** Raw S3 sink config from YAML (snake_case). */
export type S3SinkConfigRaw = z.infer<typeof s3SinkConfigSchema>

/** Raw sink config from YAML (snake_case). */
export type SinkConfigRaw = z.infer<typeof sinkConfigSchema>

/** Raw sync config from YAML (snake_case). */
export type WorkloadSyncConfigRaw = z.infer<typeof workloadSyncConfigSchema>

/** Raw workload spec from YAML (snake_case). */
export type WorkloadSpecRaw = z.infer<typeof workloadSpecSchema>

// =============================================================================
// Workload Specification Types (camelCase, for TypeScript code)
// =============================================================================

/** Volume mount configuration for a workload. */
export type VolumeConfig = CamelCasedPropertiesDeep<VolumeConfigRaw>

/** Health check configuration for containers. */
export type HealthCheckConfig = CamelCasedPropertiesDeep<HealthCheckConfigRaw>

/** Resource limits for containers. */
export type ResourceLimits = CamelCasedPropertiesDeep<ResourceLimitsRaw>

/** Resources configuration (limits and reservations). */
export type ResourcesConfig = CamelCasedPropertiesDeep<ResourcesConfigRaw>

/** Deploy configuration for containers. */
export type DeployConfig = CamelCasedPropertiesDeep<DeployConfigRaw>

/** Security configuration for containers. */
export type SecurityConfig = CamelCasedPropertiesDeep<SecurityConfigRaw>

/** Pool configuration - defines how many container instances to maintain. */
export type PoolConfig = CamelCasedPropertiesDeep<PoolConfigRaw>

/** Sync mapping for workload - defines what to sync. */
export type WorkloadSyncMapping = CamelCasedPropertiesDeep<WorkloadSyncMappingRaw>

/** Sync policy for workload - defines when to sync. */
export type WorkloadSyncPolicy = CamelCasedPropertiesDeep<WorkloadSyncPolicyRaw>

/** S3 sink configuration. */
export type S3SinkConfig = CamelCasedPropertiesDeep<S3SinkConfigRaw>

/** Sink configuration union type. */
export type SinkConfig = CamelCasedPropertiesDeep<SinkConfigRaw>

/** Workload sync configuration - embedded in WorkloadSpec. */
export type WorkloadSyncConfig = CamelCasedPropertiesDeep<WorkloadSyncConfigRaw>

/** Workload specification - defines a complete deployable unit. */
export type WorkloadSpec = CamelCasedPropertiesDeep<WorkloadSpecRaw>

// =============================================================================
// Pool Specification
// =============================================================================

/**
 * Pool specification - defines a pool of pre-warmed containers.
 */
export interface PoolSpec {
  /** Unique identifier for this pool. */
  id: PoolId
  /** ID of the workload this pool runs. */
  workloadId: WorkloadId
  /** Minimum number of idle containers to maintain. */
  minIdle: number
  /** Maximum total containers in this pool. */
  maxSize: number
  /** Time in milliseconds before an idle container is evicted. */
  idleTimeoutMs: number
  /** Docker networks for containers in this pool. */
  networks?: string[]
}

// =============================================================================
// Sync Configuration (rclone-based)
// =============================================================================

/**
 * Sync mapping - defines what data to sync and where.
 */
export interface SyncMapping {
  /** Source path inside the container. */
  containerPath: string
  /** Optional glob pattern to filter files. */
  pattern?: string
  /** Destination path prefix in the sink. */
  sinkPath: string
  /** Direction of sync. */
  direction: 'upload' | 'download' | 'bidirectional'
  /** Sync mode. */
  mode: 'sync' | 'copy'
}

/**
 * Sync status error entry.
 */
export interface SyncStatusError {
  timestamp: Date
  message: string
  mapping?: string
}

/**
 * Status of a sync operation.
 */
export interface SyncStatus {
  /** ID of the sync spec. */
  syncId: SyncId
  /** ID of the tenant. */
  tenantId: TenantId
  /** Timestamp of last successful sync. */
  lastSyncAt?: Date
  /** Number of pending sync operations. */
  pendingCount: number
  /** Recent sync errors. */
  errors: SyncStatusError[]
  /** Current sync state. */
  state: 'idle' | 'syncing' | 'error'
}

// =============================================================================
// Tenant Types
// =============================================================================

/**
 * Tenant claim state.
 */
export type TenantClaimState = 'pending' | 'claimed' | 'releasing'

/**
 * Tenant claim - tracks a tenant's container claim.
 */
export interface TenantClaim {
  /** ID of the tenant. */
  tenantId: TenantId
  /** ID of the pool the tenant has a claim in. */
  poolId: PoolId
  /** ID of the claimed container (null if pending). */
  containerId: ContainerId | null
  /** Current claim state. */
  state: TenantClaimState
  /** Tenant-specific metadata. */
  metadata?: Record<string, unknown>
  /** Timestamp when the container was claimed. */
  claimedAt?: Date
  /** Timestamp of last activity. */
  lastActivityAt?: Date
}

/**
 * Status information about a tenant's container.
 */
export interface TenantStatus {
  /** Current status of the tenant's container. */
  status: 'warm' | 'cold' | 'provisioning' | 'releasing'
  /** ID of the assigned container, if any. */
  containerId?: ContainerId
  /** ID of the pool, if assigned. */
  poolId?: PoolId
  /** ISO 8601 timestamp of last activity. */
  lastActivity?: string
  /** Sync status for this tenant. */
  syncStatus?: SyncStatus
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for the container pool.
 */
export interface ContainerPoolConfig {
  /** Minimum number of idle containers to maintain. */
  minPoolIdle: number
  /** Maximum containers allowed per node. */
  maxContainersPerNode: number
  /** Time in milliseconds before an idle container is evicted. */
  containerIdleTimeoutMs: number
  /** Maximum time in milliseconds to wait for container startup. */
  containerStartTimeoutMs: number
}

/**
 * Default resource limits for internal config (not YAML spec).
 */
export interface DefaultResourceLimits {
  /** Default CPU limit. */
  cpus: number
  /** Default memory limit in MB. */
  memory: number
  /** Default tmpfs size in MB. */
  tmpfsSize: number
}

/**
 * Full Boilerhouse configuration.
 */
export interface BoilerhouseConfig {
  /** Container pool configuration. */
  pool: ContainerPoolConfig
  /** Default resource limits for containers. */
  resources: DefaultResourceLimits
  /** Base directory for tenant state on the host. */
  stateBaseDir: string
  /** Base directory for tenant secrets on the host. */
  secretsBaseDir: string
  /** Base directory for Unix sockets on the host. */
  socketBaseDir: string
  /** Port for the API server. */
  apiPort: number
  /** Host address for the API server. */
  apiHost: string
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Request to claim a container for a tenant.
 */
export interface ClaimContainerRequest {
  /** ID of the pool to claim from. */
  poolId: PoolId
  /** Tenant-specific metadata. */
  metadata?: Record<string, unknown>
}

/**
 * Response from claiming a container.
 */
export interface ClaimContainerResponse {
  /** ID of the assigned container. */
  containerId: ContainerId
  /** Connection endpoints for the container. */
  endpoints: {
    /** Unix socket path for IPC. */
    socket?: string
    /** HTTP endpoint if exposed. */
    http?: string
  }
}

/**
 * Request to release a container.
 */
export interface ReleaseContainerRequest {
  /** Whether to sync state before releasing. */
  sync?: boolean
}
