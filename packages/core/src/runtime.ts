/**
 * Container Runtime Interface
 *
 * Abstracts container operations to support multiple backends:
 * - Docker (via dockerode)
 * - Kubernetes (via @kubernetes/client-node) - future
 *
 * The ContainerManager and ContainerPool work with this interface,
 * allowing the runtime to be swapped without changing higher-level logic.
 */

/**
 * Resource limits for a container (required fields for runtime).
 * This is separate from the YAML spec ResourceLimits which has optional fields.
 */
export interface ContainerResourceLimits {
  /** CPU limit (number of cores). */
  cpus: number
  /** Memory limit in megabytes. */
  memory: number
}

/**
 * Unique identifier for a container instance.
 * - Docker: container ID
 * - Kubernetes: pod name/namespace
 * @example 'abc123def456'
 * @example 'my-namespace/my-pod'
 */
export type RuntimeContainerId = string

/**
 * Container status as reported by the runtime.
 * - `creating`: Container is being created
 * - `running`: Container is running
 * - `stopped`: Container has stopped
 * - `failed`: Container failed to start or crashed
 * - `unknown`: Status cannot be determined
 */
export type RuntimeContainerStatus = 'creating' | 'running' | 'stopped' | 'failed' | 'unknown'

/**
 * Security configuration for containers.
 * Maps to Docker security options and Kubernetes SecurityContext.
 */
export interface ContainerSecurityConfig {
  /**
   * Mount the root filesystem as read-only.
   * @example true
   */
  readOnlyRootFilesystem: boolean

  /**
   * Require the container to run as a non-root user.
   * @example true
   */
  runAsNonRoot: boolean

  /**
   * Specific user ID to run as.
   * @example 1000
   */
  runAsUser?: number

  /**
   * Drop all Linux capabilities.
   * @example true
   */
  dropAllCapabilities: boolean

  /**
   * Prevent privilege escalation via setuid binaries.
   * @example true
   */
  noNewPrivileges: boolean

  /**
   * Capabilities to add back after dropping all.
   * @example ['NET_BIND_SERVICE']
   */
  addCapabilities?: string[]
}

/**
 * Volume mount configuration.
 * Maps to Docker binds and Kubernetes volume mounts.
 */
export interface VolumeMount {
  /**
   * Path on host (Docker) or volume name (Kubernetes).
   * @example '/var/lib/boilerhouse/states/tenant-123'
   */
  source: string

  /**
   * Path inside container.
   * @example '/state'
   */
  target: string

  /**
   * Mount as read-only.
   * @example false
   */
  readOnly: boolean
}

/**
 * Tmpfs mount configuration.
 * Maps to Docker tmpfs and Kubernetes emptyDir with memory medium.
 */
export interface TmpfsMount {
  /**
   * Path inside container.
   * @example '/tmp'
   */
  target: string

  /**
   * Size limit in bytes.
   * @example 104857600
   */
  sizeBytes: number

  /**
   * Mount mode (permissions).
   * @example 0o1777
   */
  mode?: number
}

/**
 * Network configuration for containers.
 */
export interface NetworkConfig {
  /**
   * Network name/mode.
   * - Docker: network name (e.g., "boilerhouse-egress")
   * - Kubernetes: network policy name
   * @example 'boilerhouse-egress'
   */
  network: string

  /**
   * DNS servers to use (bypasses internal DNS).
   * @example ['8.8.8.8', '1.1.1.1']
   */
  dnsServers?: string[]
}

/**
 * Environment variable for a container.
 */
export interface EnvVar {
  /**
   * Variable name.
   * @example 'NODE_ENV'
   */
  name: string

  /**
   * Variable value.
   * @example 'production'
   */
  value: string
}

/**
 * Health check configuration for containers.
 * Maps to Docker HEALTHCHECK and Kubernetes liveness/readiness probes.
 */
export interface HealthCheckSpec {
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

  /**
   * Time to wait before starting health checks (startup grace period).
   * @example 5000
   */
  startPeriodMs?: number
}

/**
 * Full container specification for creation.
 */
export interface ContainerSpec {
  /**
   * Container/pod name.
   * @example 'container-ml7wk37p'
   */
  name: string

  /**
   * Container image.
   * @example 'boilerhouse-container:latest'
   */
  image: string

  /**
   * Command to run (overrides entrypoint).
   * @example ['/bin/sh', '-c']
   */
  command?: string[]

  /**
   * Arguments to command.
   * @example ['echo', 'hello']
   */
  args?: string[]

  /**
   * Environment variables.
   */
  env: EnvVar[]

  /**
   * Volume mounts.
   */
  volumes: VolumeMount[]

  /**
   * Tmpfs mounts.
   */
  tmpfs: TmpfsMount[]

  /**
   * Resource limits.
   */
  resources: ContainerResourceLimits

  /**
   * Security configuration.
   */
  security: ContainerSecurityConfig

  /**
   * Network configuration.
   */
  network: NetworkConfig

  /**
   * Labels/annotations for tracking.
   * @example { 'boilerhouse.managed': 'true', 'boilerhouse.tenant-id': 'tenant-123' }
   */
  labels: Record<string, string>

  /**
   * Health check configuration.
   * If not provided, container is considered healthy when running.
   */
  healthCheck?: HealthCheckSpec
}

/**
 * Container info returned by the runtime.
 */
export interface ContainerInfo {
  /**
   * Runtime-specific container ID.
   * @example 'abc123def456'
   */
  id: RuntimeContainerId

  /**
   * Container name.
   * @example 'container-ml7wk37p'
   */
  name: string

  /**
   * Current status.
   */
  status: RuntimeContainerStatus

  /**
   * When the container was created.
   */
  createdAt: Date

  /**
   * When the container started (if running).
   */
  startedAt?: Date

  /**
   * Labels/annotations.
   */
  labels: Record<string, string>
}

/**
 * Container Runtime Interface.
 *
 * Implementations:
 * - DockerRuntime: Uses dockerode to manage containers
 * - KubernetesRuntime: Uses @kubernetes/client-node to manage pods (future)
 */
export interface ContainerRuntime {
  /**
   * Runtime name for logging/debugging.
   * @example 'docker'
   * @example 'kubernetes'
   */
  readonly name: string

  /**
   * Create and start a container.
   * @param spec Container specification
   * @returns Container info after creation
   */
  createContainer(spec: ContainerSpec): Promise<ContainerInfo>

  /**
   * Stop a running container.
   * @param id Container ID
   * @param timeoutSeconds Seconds to wait before force kill
   */
  stopContainer(id: RuntimeContainerId, timeoutSeconds?: number): Promise<void>

  /**
   * Remove a container (must be stopped first).
   * @param id Container ID
   */
  removeContainer(id: RuntimeContainerId): Promise<void>

  /**
   * Stop and remove a container in one operation.
   * @param id Container ID
   * @param timeoutSeconds Seconds to wait before force kill
   */
  destroyContainer(id: RuntimeContainerId, timeoutSeconds?: number): Promise<void>

  /**
   * Get container info.
   * @param id Container ID
   * @returns Container info or null if not found
   */
  getContainer(id: RuntimeContainerId): Promise<ContainerInfo | null>

  /**
   * Check if container is healthy/running.
   * @param id Container ID
   * @returns True if container is running
   */
  isHealthy(id: RuntimeContainerId): Promise<boolean>

  /**
   * List containers matching labels.
   * @param labels Labels to filter by
   * @returns List of matching containers
   */
  listContainers(labels: Record<string, string>): Promise<ContainerInfo[]>

  /**
   * Execute a command in a running container.
   * @param id Container ID
   * @param command Command and arguments
   * @returns Exit code, stdout, and stderr
   */
  exec(
    id: RuntimeContainerId,
    command: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

/**
 * Default security configuration.
 * Provides strong isolation suitable for running untrusted workloads.
 */
export const DEFAULT_SECURITY_CONFIG: ContainerSecurityConfig = {
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  dropAllCapabilities: true,
  noNewPrivileges: true,
}

/**
 * Default network configuration.
 * Uses public DNS to avoid leaking internal service names.
 */
export const DEFAULT_NETWORK_CONFIG: Partial<NetworkConfig> = {
  dnsServers: ['8.8.8.8', '1.1.1.1'],
}
