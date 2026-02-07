/**
 * Domain Error Types
 *
 * Custom error classes with HTTP status codes for automatic error handling.
 * Elysia's error handler maps error.status to HTTP responses.
 */

export class PoolCapacityError extends Error {
  readonly status = 429

  constructor(poolId: string, maxSize: number) {
    super(`Pool ${poolId} is at maximum capacity (${maxSize})`)
    this.name = 'PoolCapacityError'
  }
}

export class ContainerNotFoundError extends Error {
  readonly status = 404

  constructor(message: string) {
    super(message)
    this.name = 'ContainerNotFoundError'
  }
}

export class PoolNotFoundError extends Error {
  readonly status = 404

  constructor(poolId: string) {
    super(`Pool ${poolId} not found`)
    this.name = 'PoolNotFoundError'
  }
}

export class TenantNotFoundError extends Error {
  readonly status = 404

  constructor(tenantId: string) {
    super(`Tenant ${tenantId} not found`)
    this.name = 'TenantNotFoundError'
  }
}

export class WorkloadNotFoundError extends Error {
  readonly status = 404

  constructor(workloadId: string) {
    super(`Workload ${workloadId} not found`)
    this.name = 'WorkloadNotFoundError'
  }
}

export class SyncNotConfiguredError extends Error {
  readonly status = 400

  constructor() {
    super('No sync configuration for this workload')
    this.name = 'SyncNotConfiguredError'
  }
}

/**
 * Type guard for domain errors with an HTTP status code.
 */
export function isDomainError(err: unknown): err is Error & { status: number } {
  return (
    err instanceof Error &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  )
}
