/**
 * Core types for the Boilerhouse container pool orchestrator
 */

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
 * - `idle`: Container is pre-warmed and available for assignment
 * - `assigned`: Container is assigned to a tenant and processing requests
 * - `stopping`: Container is being stopped or released
 */
export type ContainerStatus = 'idle' | 'assigned' | 'stopping'

/**
 * Represents a running container instance in the pool.
 */
export interface PoolContainer {
  /**
   * Unique identifier for this container.
   * @example 'ml7wk37p-vbjcpb5g'
   */
  containerId: ContainerId

  /**
   * ID of the tenant this container is assigned to.
   * Null when container is pre-warmed and unassigned.
   * @example 'tenant-12345'
   */
  tenantId: TenantId | null

  /**
   * ID of the pool this container belongs to.
   * @example 'prod-workers'
   */
  poolId: PoolId

  /**
   * Path to the Unix socket for communicating with the container.
   * @example '/var/run/boilerhouse/ml7wk37p/app.sock'
   */
  socketPath: string

  /**
   * Host path to the container's mounted state directory.
   * @example '/var/lib/boilerhouse/states/ml7wk37p'
   */
  stateDir: string

  /**
   * Host path to the container's mounted secrets directory.
   * @example '/var/lib/boilerhouse/secrets/ml7wk37p'
   */
  secretsDir: string

  /**
   * Timestamp of the last activity on this container.
   * Used for idle timeout and eviction decisions.
   */
  lastActivity: Date

  /**
   * Current lifecycle status of the container.
   */
  status: ContainerStatus
}

// =============================================================================
// Workload Specification
// =============================================================================

/**
 * Volume mount configuration for a workload.
 */
export interface VolumeConfig {
  /**
   * Path inside the container where the volume is mounted.
   * @example '/data'
   */
  containerPath: string

  /**
   * Mount mode: read-write or read-only.
   */
  mode: 'rw' | 'ro'
}

/**
 * Health check configuration for containers.
 */
export interface HealthCheckConfig {
  /**
   * Command to execute for health check.
   * @example ['curl', '-f', 'http://localhost:8080/health']
   * @example ['python', '-c', 'print("ok")']
   */
  command: string[]

  /**
   * Interval between health checks in milliseconds.
   * @example 30000
   */
  intervalMs: number

  /**
   * Timeout for each health check in milliseconds.
   * @example 5000
   */
  timeoutMs: number

  /**
   * Number of consecutive failures before marking unhealthy.
   * @example 3
   */
  retries: number
}

/**
 * Security configuration for containers.
 */
export interface SecurityConfig {
  /**
   * Whether the root filesystem is read-only.
   * @default true
   */
  readOnlyRootFilesystem?: boolean

  /**
   * User ID to run the container as.
   * @example 1000
   */
  runAsUser?: number

  /**
   * Network mode for the container.
   * @example 'none' for isolated containers
   * @example 'bridge' for network access
   */
  networkMode?: 'none' | 'bridge' | 'host' | string
}

/**
 * Workload specification - defines how to run a container type.
 * Developers using Boilerhouse define workloads to describe their container images.
 */
export interface WorkloadSpec {
  /**
   * Unique identifier for this workload.
   * @example 'python-worker'
   */
  id: WorkloadId

  /**
   * Human-readable name for the workload.
   * @example 'Python ML Worker'
   */
  name: string

  /**
   * Docker image to use for this workload.
   * @example 'myregistry/python-worker:latest'
   */
  image: string

  /**
   * Volume mount configuration.
   */
  volumes: {
    /**
     * State volume for persistent tenant data.
     */
    state?: VolumeConfig

    /**
     * Secrets volume for credentials (typically read-only).
     */
    secrets?: VolumeConfig

    /**
     * Communication volume for IPC (sockets, etc.).
     */
    comm?: VolumeConfig

    /**
     * Additional custom volumes.
     */
    custom?: Array<VolumeConfig & { name: string }>
  }

  /**
   * Environment variables to set in containers.
   * Supports ${VAR} substitution for dynamic values.
   * @example { 'APP_STATE_DIR': '/data', 'LOG_LEVEL': 'info' }
   */
  environment: Record<string, string>

  /**
   * Health check configuration.
   */
  healthCheck: HealthCheckConfig

  /**
   * Resource limits (overrides pool defaults).
   */
  resources?: Partial<ResourceLimits>

  /**
   * Security configuration (overrides defaults).
   */
  security?: SecurityConfig

  /**
   * JSON Schema for validating tenant config.
   * When set, tenant configs are validated against this schema.
   */
  configSchema?: Record<string, unknown>
}

// =============================================================================
// Pool Specification
// =============================================================================

/**
 * Network configuration for a pool.
 */
export interface PoolNetworkConfig {
  /**
   * Name of the Docker network to attach containers to.
   * @example 'boilerhouse-egress'
   */
  name: string

  /**
   * Custom DNS servers for containers.
   * @example ['8.8.8.8', '8.8.4.4']
   */
  dns?: string[]
}

/**
 * Pool specification - defines a pool of pre-warmed containers.
 */
export interface PoolSpec {
  /**
   * Unique identifier for this pool.
   * @example 'prod-workers'
   */
  id: PoolId

  /**
   * ID of the workload this pool runs.
   * @example 'python-worker'
   */
  workloadId: WorkloadId

  /**
   * Minimum number of idle containers to maintain.
   * @example 5
   */
  minSize: number

  /**
   * Maximum total containers in this pool.
   * @example 50
   */
  maxSize: number

  /**
   * Time in milliseconds before an idle container is evicted.
   * @example 300000
   */
  idleTimeoutMs: number

  /**
   * Network configuration for containers in this pool.
   */
  network?: PoolNetworkConfig
}

// =============================================================================
// Sync Configuration (rclone-based)
// =============================================================================

/**
 * Sync mapping - defines what data to sync and where.
 */
export interface SyncMapping {
  /**
   * Source path inside the container.
   * @example '/data/sessions'
   */
  containerPath: string

  /**
   * Optional glob pattern to filter files.
   * @example '*.json'
   * @example '**\/*.log'
   */
  pattern?: string

  /**
   * Destination path prefix in the sink.
   * @example 'sessions/'
   */
  sinkPath: string

  /**
   * Direction of sync.
   * - 'upload': Container to sink
   * - 'download': Sink to container
   * - 'bidirectional': Both directions
   */
  direction: 'upload' | 'download' | 'bidirectional'

  /**
   * Sync mode.
   * - 'sync': Mirror source to destination (deletes removed files)
   * - 'copy': Copy files without deleting
   */
  mode: 'sync' | 'copy'
}

/**
 * Sync policy - defines when to sync.
 */
export interface SyncPolicy {
  /**
   * Sync when a tenant claims a container (download state).
   */
  onClaim?: boolean

  /**
   * Sync when a tenant releases a container (upload state).
   */
  onRelease?: boolean

  /**
   * Periodic sync interval in milliseconds.
   * @example 60000 for every minute
   */
  intervalMs?: number

  /**
   * Allow manual sync trigger via API.
   */
  allowManualTrigger?: boolean
}

/**
 * S3 sink configuration (v1 only sink type).
 */
export interface S3SinkConfig {
  type: 's3'

  /**
   * S3 bucket name.
   * @example 'my-app-state'
   */
  bucket: string

  /**
   * AWS region.
   * @example 'us-west-2'
   */
  region: string

  /**
   * Base path prefix in the bucket.
   * Supports ${tenantId} interpolation.
   * @example 'tenants/${tenantId}/'
   */
  prefix: string

  /**
   * AWS access key ID (optional if using IAM role).
   */
  accessKeyId?: string

  /**
   * AWS secret access key (optional if using IAM role).
   */
  secretAccessKey?: string

  /**
   * Additional rclone flags for S3 operations.
   * @example ['--s3-upload-cutoff=100M']
   */
  rcloneFlags?: string[]
}

/**
 * Sink configuration union type.
 * v1 only supports S3. Future versions may add GCS, Azure, etc.
 */
export type SinkConfig = S3SinkConfig

/**
 * Sync specification - defines complete sync configuration for a pool.
 */
export interface SyncSpec {
  /**
   * Unique identifier for this sync spec.
   * @example 'worker-state-sync'
   */
  id: SyncId

  /**
   * ID of the pool this sync applies to.
   * @example 'prod-workers'
   */
  poolId: PoolId

  /**
   * Sync mappings defining what to sync.
   */
  mappings: SyncMapping[]

  /**
   * Sink configuration (where to sync).
   */
  sink: SinkConfig

  /**
   * Sync policy (when to sync).
   */
  policy: SyncPolicy
}

/**
 * Status of a sync operation.
 */
export interface SyncStatus {
  /**
   * ID of the sync spec.
   */
  syncId: SyncId

  /**
   * ID of the tenant.
   */
  tenantId: TenantId

  /**
   * Timestamp of last successful sync.
   */
  lastSyncAt?: Date

  /**
   * Number of pending sync operations.
   */
  pendingCount: number

  /**
   * Recent sync errors.
   */
  errors: Array<{
    timestamp: Date
    message: string
    mapping?: string
  }>

  /**
   * Current sync state.
   */
  state: 'idle' | 'syncing' | 'error'
}

// =============================================================================
// Tenant Types
// =============================================================================

/**
 * Tenant assignment state.
 */
export type TenantAssignmentState = 'pending' | 'assigned' | 'releasing'

/**
 * Tenant assignment - tracks a tenant's container assignment.
 */
export interface TenantAssignment {
  /**
   * ID of the tenant.
   * @example 'tenant-12345'
   */
  tenantId: TenantId

  /**
   * ID of the pool the tenant is assigned to.
   * @example 'prod-workers'
   */
  poolId: PoolId

  /**
   * ID of the assigned container (null if pending).
   * @example 'ml7wk37p-vbjcpb5g'
   */
  containerId: ContainerId | null

  /**
   * Current assignment state.
   */
  state: TenantAssignmentState

  /**
   * Tenant-specific metadata.
   * Workload-specific data passed when claiming a container.
   */
  metadata?: Record<string, unknown>

  /**
   * Timestamp when the container was assigned.
   */
  assignedAt?: Date

  /**
   * Timestamp of last activity.
   */
  lastActivityAt?: Date
}

/**
 * Status information about a tenant's container.
 */
export interface TenantStatus {
  /**
   * Current status of the tenant's container.
   * - `warm`: Container is running and assigned to this tenant
   * - `cold`: No container assigned, will need cold start
   * - `provisioning`: Container is being provisioned
   * - `releasing`: Container is being released
   */
  status: 'warm' | 'cold' | 'provisioning' | 'releasing'

  /**
   * ID of the assigned container, if any.
   * @example 'ml7wk37p-vbjcpb5g'
   */
  containerId?: ContainerId

  /**
   * ID of the pool, if assigned.
   */
  poolId?: PoolId

  /**
   * ISO 8601 timestamp of last activity.
   * @example '2024-01-15T14:22:00Z'
   */
  lastActivity?: string

  /**
   * Sync status for this tenant.
   */
  syncStatus?: SyncStatus
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for the container pool.
 */
export interface ContainerPoolConfig {
  /**
   * Minimum number of pre-warmed containers to maintain.
   * @example 5
   */
  minPoolSize: number

  /**
   * Maximum containers allowed per node.
   * @example 50
   */
  maxContainersPerNode: number

  /**
   * Time in milliseconds before an idle container is evicted.
   * @example 300000
   */
  containerIdleTimeoutMs: number

  /**
   * Maximum time in milliseconds to wait for container startup.
   * @example 30000
   */
  containerStartTimeoutMs: number
}

/**
 * Resource limits for containers.
 */
export interface ResourceLimits {
  /**
   * Number of CPUs allocated to the container.
   * @example 1
   */
  cpus: number

  /**
   * Memory limit in megabytes.
   * @example 512
   */
  memoryMb: number

  /**
   * Tmpfs size limit in megabytes.
   * @example 100
   */
  tmpfsSizeMb: number
}

/**
 * Full Boilerhouse configuration.
 */
export interface BoilerhouseConfig {
  /**
   * Container pool configuration.
   */
  pool: ContainerPoolConfig

  /**
   * Default resource limits for containers.
   */
  resources: ResourceLimits

  /**
   * Base directory for tenant state on the host.
   * @example '/var/lib/boilerhouse/states'
   */
  stateBaseDir: string

  /**
   * Base directory for tenant secrets on the host.
   * @example '/var/lib/boilerhouse/secrets'
   */
  secretsBaseDir: string

  /**
   * Base directory for Unix sockets on the host.
   * @example '/var/run/boilerhouse'
   */
  socketBaseDir: string

  /**
   * Port for the API server.
   * @example 3000
   */
  apiPort: number

  /**
   * Host address for the API server.
   * @example '0.0.0.0'
   */
  apiHost: string
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Request to claim a container for a tenant.
 */
export interface ClaimContainerRequest {
  /**
   * ID of the pool to claim from.
   */
  poolId: PoolId

  /**
   * Tenant-specific metadata.
   * Workload-specific data stored with the assignment.
   */
  metadata?: Record<string, unknown>
}

/**
 * Response from claiming a container.
 */
export interface ClaimContainerResponse {
  /**
   * ID of the assigned container.
   */
  containerId: ContainerId

  /**
   * Connection endpoints for the container.
   */
  endpoints: {
    /**
     * Unix socket path for IPC.
     */
    socket?: string

    /**
     * HTTP endpoint if exposed.
     */
    http?: string
  }
}

/**
 * Request to release a container.
 */
export interface ReleaseContainerRequest {
  /**
   * Whether to sync state before releasing.
   * @default true
   */
  sync?: boolean
}
