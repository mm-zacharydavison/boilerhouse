/**
 * Sink Adapter
 *
 * Abstracts sink-specific rclone configuration.
 * Each sink type (S3, GCS, Azure, etc.) implements this interface.
 */

import type { SinkConfig, TenantId } from '@boilerhouse/core'
import { S3SinkAdapter } from './sink-adapters'

/**
 * Interface for sink-specific rclone operations.
 * Implementations provide the rclone remote path format and arguments for each sink type.
 */
export interface SinkAdapter {
  /**
   * The sink type this adapter handles.
   * @example 's3'
   */
  readonly type: string

  /**
   * Build the rclone remote path for this sink.
   *
   * @param sink - Sink configuration
   * @param tenantId - Tenant ID for path interpolation
   * @param sinkPath - Relative path within the sink
   * @returns Full rclone remote path (e.g., ':s3:bucket/prefix/path')
   */
  buildRemotePath(sink: SinkConfig, tenantId: TenantId, sinkPath: string): string

  /**
   * Get rclone arguments specific to this sink type.
   *
   * @param sink - Sink configuration
   * @returns Array of rclone arguments (e.g., ['--s3-region', 'us-west-2'])
   */
  getRcloneArgs(sink: SinkConfig): string[]
}

/**
 * Registry for sink adapters.
 * Provides the appropriate adapter for each sink type.
 */
export class SinkAdapterRegistry {
  private adapters: Map<string, SinkAdapter> = new Map()

  constructor() {
    // Register built-in adapters
    this.register(new S3SinkAdapter())
  }

  /**
   * Register a sink adapter.
   */
  register(adapter: SinkAdapter): void {
    this.adapters.set(adapter.type, adapter)
  }

  /**
   * Get the adapter for a sink configuration.
   * @throws Error if no adapter is registered for the sink type
   */
  getAdapter(sink: SinkConfig): SinkAdapter {
    const adapter = this.adapters.get(sink.type)
    if (!adapter) {
      throw new Error(`No adapter registered for sink type '${sink.type}'`)
    }
    return adapter
  }

  /**
   * Check if an adapter is registered for a sink type.
   */
  hasAdapter(type: string): boolean {
    return this.adapters.has(type)
  }
}

/**
 * Default singleton registry with built-in adapters.
 */
export const defaultSinkAdapterRegistry = new SinkAdapterRegistry()
