import { z } from 'zod'
import { snakeToCamelDeep } from '../case-convert'
import type { WorkloadSpec, WorkloadSpecRaw } from '../types'

/**
 * Parse duration string (e.g., "30s", "5m", "1000ms") to milliseconds
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h)$/)
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`)
  }
  const value = Number.parseInt(match[1], 10)
  const unit = match[2]
  switch (unit) {
    case 'ms':
      return value
    case 's':
      return value * 1000
    case 'm':
      return value * 60 * 1000
    case 'h':
      return value * 60 * 60 * 1000
    default:
      throw new Error(`Unknown duration unit: ${unit}`)
  }
}

/**
 * Format milliseconds to duration string
 */
export function formatDuration(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

/**
 * Parse memory string (e.g., "512m", "1g") to megabytes
 */
export function parseMemory(memory: string): number {
  const match = memory.match(/^(\d+)(b|k|m|g|kb|mb|gb)$/i)
  if (!match) {
    throw new Error(`Invalid memory format: ${memory}`)
  }
  const value = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  switch (unit) {
    case 'b':
      return Math.ceil(value / (1024 * 1024))
    case 'k':
    case 'kb':
      return Math.ceil(value / 1024)
    case 'm':
    case 'mb':
      return value
    case 'g':
    case 'gb':
      return value * 1024
    default:
      throw new Error(`Unknown memory unit: ${unit}`)
  }
}

/**
 * Format megabytes to memory string
 */
export function formatMemory(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}g`
  return `${mb}m`
}

// Duration string pattern (e.g., "30s", "5m", "1000ms", "1h")
const durationPattern = /^[0-9]+(ms|s|m|h)$/
const durationString = z
  .string()
  .regex(durationPattern, 'Must be a duration string (e.g., "30s", "5m", "1000ms")')

// Memory string pattern (e.g., "512m", "1g")
const memoryPattern = /^[0-9]+(b|k|m|g|kb|mb|gb)$/i
const memoryString = z.string().regex(memoryPattern, 'Must be a memory string (e.g., "512m", "1g")')

// Workload ID pattern (lowercase alphanumeric with hyphens)
const workloadIdPattern = /^[a-z][a-z0-9-]*$/
const workloadId = z
  .string()
  .regex(workloadIdPattern, 'Must be lowercase alphanumeric with hyphens, starting with a letter')

// =============================================================================
// Volume Configuration (docker-compose compatible field names)
// =============================================================================

/**
 * Volume configuration schema
 * Field names match docker-compose long syntax
 */
export const volumeConfigSchema = z.object({
  target: z.string().describe('Path inside the container where the volume is mounted'),
  read_only: z.boolean().optional().default(false).describe('Mount as read-only'),
  seed: z
    .string()
    .optional()
    .describe(
      'Path to a directory of seed files to copy into this volume during claim. ' +
        'Only copies when the volume is empty. Resolved relative to the workload YAML file.',
    ),
})

/**
 * Custom volume configuration with name
 */
export const customVolumeSchema = volumeConfigSchema.extend({
  name: z.string().regex(workloadIdPattern).describe('Unique name for this custom volume'),
})

/**
 * Volumes configuration schema
 */
export const volumesSchema = z.object({
  state: volumeConfigSchema.optional().describe('State volume for persistent tenant data'),
  secrets: volumeConfigSchema.optional().describe('Secrets volume for credentials'),
  comm: volumeConfigSchema.optional().describe('Communication volume for IPC'),
  custom: z.array(customVolumeSchema).optional().describe('Additional custom volumes'),
})

// =============================================================================
// Health Check Configuration (docker-compose compatible)
// =============================================================================

/**
 * Health check configuration schema
 * Field names match docker-compose healthcheck spec
 */
export const healthCheckConfigSchema = z.object({
  test: z.array(z.string()).describe('Command to execute for health check'),
  interval: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .describe('Interval between health checks'),
  timeout: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .describe('Timeout for each health check'),
  retries: z
    .number()
    .int()
    .min(1)
    .describe('Number of consecutive failures before marking unhealthy'),
  start_period: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .optional()
    .describe('Time to wait before starting health checks'),
})

// =============================================================================
// Resource Configuration (docker-compose compatible)
// =============================================================================

/**
 * Resource limits schema
 * Matches docker-compose deploy.resources.limits
 */
export const resourceLimitsSchema = z.object({
  cpus: z
    .union([z.number().min(0), z.string()])
    .optional()
    .describe('CPU limit (e.g., "0.5", "2")'),
  memory: z
    .union([z.number().int().min(0), memoryString.transform(parseMemory)])
    .optional()
    .describe('Memory limit (e.g., "512M", "2G")'),
})

/**
 * Resources configuration (limits and reservations)
 * Matches docker-compose deploy.resources
 */
export const resourcesConfigSchema = z.object({
  limits: resourceLimitsSchema.optional().describe('Resource limits'),
  reservations: resourceLimitsSchema.optional().describe('Resource reservations'),
})

/**
 * Deploy configuration schema
 * Matches docker-compose deploy section
 */
export const deployConfigSchema = z.object({
  resources: resourcesConfigSchema.optional().describe('Resource constraints'),
})

// =============================================================================
// Security Configuration
// =============================================================================

/**
 * Security configuration schema (deprecated, use top-level fields)
 * Kept for backwards compatibility
 */
export const securityConfigSchema = z.object({
  read_only: z.boolean().optional().describe('Whether the root filesystem is read-only'),
  user: z
    .union([z.number().int().min(0), z.string()])
    .optional()
    .describe('User to run the container as'),
  network_mode: z
    .enum(['none', 'bridge', 'host'])
    .or(z.string())
    .optional()
    .describe('Network mode for the container'),
})

// =============================================================================
// Pool Configuration
// =============================================================================

/**
 * Pool configuration schema - defines how many container instances to maintain
 */
export const poolConfigSchema = z.object({
  min_idle: z.number().int().min(0).default(1).describe('Minimum number of idle containers'),
  max_size: z.number().int().min(1).default(10).describe('Maximum total containers'),
  idle_timeout: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .optional()
    .describe('Time before an idle container is evicted (e.g., "5m")'),
  file_idle_ttl: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .optional()
    .describe(
      'Filesystem inactivity timeout before auto-releasing a claimed container (e.g., "5m")',
    ),
  networks: z
    .array(z.string())
    .optional()
    .describe('Docker networks to attach containers to (first is primary)'),
  dns: z.array(z.string()).optional().describe('Custom DNS servers for containers'),
})

// =============================================================================
// Sync Configuration
// =============================================================================

/**
 * Sync mapping - defines what data to sync and where
 */
export const workloadSyncMappingSchema = z.object({
  path: z.string().describe('Source path inside the container (e.g., /data)'),
  pattern: z.string().optional().describe('Optional glob pattern to filter files (e.g., *.json)'),
  sink_path: z
    .string()
    .optional()
    .describe('Destination path prefix in the sink (defaults to path basename)'),
  direction: z
    .enum(['upload', 'download', 'bidirectional'])
    .optional()
    .default('bidirectional')
    .describe('Direction of sync'),
  mode: z
    .enum(['sync', 'copy'])
    .optional()
    .default('sync')
    .describe('Sync mode (sync mirrors, copy preserves)'),
})

/**
 * Sync policy - defines when to sync
 */
export const workloadSyncPolicySchema = z.object({
  on_claim: z
    .boolean()
    .optional()
    .default(true)
    .describe('Sync when tenant claims container (download state)'),
  on_release: z
    .boolean()
    .optional()
    .default(true)
    .describe('Sync when tenant releases container (upload state)'),
  interval: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .optional()
    .describe('Periodic sync interval (e.g., "5m")'),
  manual: z.boolean().optional().default(true).describe('Allow manual sync trigger via API'),
})

/**
 * S3 sink configuration
 */
export const s3SinkConfigSchema = z.object({
  type: z.literal('s3'),
  bucket: z.string().describe('S3 bucket name'),
  region: z.string().describe('AWS region'),
  prefix: z
    .string()
    .optional()
    .default('tenants/${tenantId}/')
    .describe('Base path prefix, supports ${tenantId} interpolation'),
  access_key_id: z.string().optional().describe('AWS access key ID (optional if using IAM role)'),
  secret_access_key: z
    .string()
    .optional()
    .describe('AWS secret access key (optional if using IAM role)'),
  endpoint: z.string().optional().describe('Custom S3 endpoint (for S3-compatible services)'),
  rclone_flags: z.array(z.string()).optional().describe('Additional rclone flags'),
})

/**
 * Sink configuration (extensible for future sink types)
 */
export const sinkConfigSchema = z.discriminatedUnion('type', [s3SinkConfigSchema])

/**
 * Sync configuration schema - defines state synchronization to remote storage
 */
export const workloadSyncConfigSchema = z.object({
  sink: sinkConfigSchema.describe('Where to sync (S3, etc.)'),
  mappings: z
    .array(workloadSyncMappingSchema)
    .optional()
    .describe('What paths to sync (defaults to state volume)'),
  policy: workloadSyncPolicySchema.optional().describe('When to sync'),
})

// =============================================================================
// Lifecycle Hooks Configuration
// =============================================================================

/**
 * A single hook command to execute inside a container
 */
export const hookCommandSchema = z.object({
  command: z.array(z.string()).min(1).describe('Command to execute inside the container'),
  timeout: z
    .union([z.number().int().min(0), durationString.transform(parseDuration)])
    .optional()
    .default(30000)
    .describe('Maximum time for the command to complete (e.g., "30s")'),
  on_error: z
    .enum(['fail', 'continue', 'retry'])
    .optional()
    .default('fail')
    .describe('Behavior on non-zero exit or timeout'),
  retries: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(1)
    .describe('Number of attempts (only used when on_error is retry)'),
})

/**
 * Lifecycle hooks configuration
 */
export const hooksSchema = z.object({
  post_claim: z
    .array(hookCommandSchema)
    .optional()
    .describe('Commands to run after container is claimed, synced, seeded, restarted, and healthy'),
  pre_release: z
    .array(hookCommandSchema)
    .optional()
    .describe('Commands to run before sync upload and pool release'),
})

// =============================================================================
// Main Workload Schema
// =============================================================================

/**
 * Workload specification schema
 * A workload defines a complete deployable unit: container config + pool sizing + sync
 * Field names align with docker-compose where applicable
 */
export const workloadSpecSchema = z.object({
  // Identity (boilerhouse-specific)
  id: workloadId.describe('Unique identifier for this workload'),
  name: z.string().describe('Human-readable name for the workload'),

  // Container configuration (docker-compose compatible field names)
  image: z.string().describe('Docker image to use for this workload'),
  command: z.array(z.string()).optional().describe('Command to run (overrides image entrypoint)'),
  volumes: volumesSchema.default({}).describe('Volume mount configuration'),
  environment: z.record(z.string(), z.string()).default({}).describe('Environment variables'),
  healthcheck: healthCheckConfigSchema.describe('Health check configuration'),

  // Deploy configuration (docker-compose compatible)
  deploy: deployConfigSchema
    .optional()
    .describe('Deployment configuration including resource limits'),

  // Security options (top-level like docker-compose)
  read_only: z.boolean().optional().describe('Mount root filesystem as read-only'),
  user: z
    .union([z.number().int().min(0), z.string()])
    .optional()
    .describe('User to run the container as'),
  network_mode: z
    .enum(['none', 'bridge', 'host'])
    .or(z.string())
    .optional()
    .describe('Network mode for the container (legacy, prefer "networks")'),
  networks: z
    .array(z.string())
    .optional()
    .describe('Docker networks to attach containers to (first is primary)'),
  dns: z.array(z.string()).optional().describe('Custom DNS servers for containers'),

  // Pool configuration (boilerhouse-specific)
  pool: poolConfigSchema.optional().describe('Pool sizing and network configuration'),

  // Sync configuration (boilerhouse-specific)
  sync: workloadSyncConfigSchema.optional().describe('State synchronization configuration'),

  // Lifecycle hooks (boilerhouse-specific)
  hooks: hooksSchema.optional().describe('Lifecycle hook commands'),
})

// =============================================================================
// Validation utilities
// =============================================================================

/**
 * Validation error detail
 */
export interface ValidationError {
  path: string
  message: string
}

/**
 * Parse result type
 */
export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; errors: ValidationError[] }

/**
 * Parse and validate workload data (returns raw snake_case)
 */
export function parseWorkloadSpecRaw(data: unknown): WorkloadSpecRaw {
  return workloadSpecSchema.parse(data)
}

/**
 * Parse and validate workload data (returns camelCase)
 */
export function parseWorkloadSpec(data: unknown): WorkloadSpec {
  const raw = workloadSpecSchema.parse(data)
  return snakeToCamelDeep(raw) as WorkloadSpec
}

/**
 * Safely parse workload data, returning result with errors (returns raw snake_case)
 */
export function safeParseWorkloadSpecRaw(data: unknown): ParseResult<WorkloadSpecRaw> {
  const result = workloadSpecSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '/',
    message: issue.message,
  }))
  return { success: false, errors }
}

/**
 * Safely parse workload data, returning result with errors (returns camelCase)
 */
export function safeParseWorkloadSpec(data: unknown): ParseResult<WorkloadSpec> {
  const result = workloadSpecSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: snakeToCamelDeep(result.data) as WorkloadSpec }
  }
  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '/',
    message: issue.message,
  }))
  return { success: false, errors }
}
