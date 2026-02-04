/**
 * Rclone Sync Executor
 *
 * Executes rclone commands for syncing data between container volumes and remote storage.
 * Supports upload, download, and bidirectional sync with any rclone-supported sink.
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { SinkConfig, SyncMapping, TenantId } from '@boilerhouse/core'
import {
  type SinkAdapter,
  type SinkAdapterRegistry,
  defaultSinkAdapterRegistry,
} from './sink-adapter'

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  /** Whether the sync operation completed successfully. */
  success: boolean

  /** Number of bytes transferred. */
  bytesTransferred?: number

  /** Number of files transferred. */
  filesTransferred?: number

  /**
   * Error messages if the sync failed.
   * @example ['rclone: Failed to copy: AccessDenied']
   */
  errors?: string[]

  /** Duration of the sync operation in milliseconds. */
  duration: number
}

/**
 * Configuration for the RcloneSyncExecutor.
 */
export interface RcloneSyncExecutorConfig {
  /**
   * Path to rclone binary.
   * @default 'rclone'
   * @example '/usr/local/bin/rclone'
   */
  rclonePath?: string

  /**
   * Default timeout for sync operations in milliseconds.
   * @default 300000
   */
  defaultTimeoutMs?: number

  /**
   * Enable verbose logging of rclone operations.
   * @default false
   */
  verbose?: boolean

  /**
   * Custom sink adapter registry.
   * If not provided, uses the default registry with built-in adapters.
   */
  sinkAdapterRegistry?: SinkAdapterRegistry
}

interface ResolvedConfig {
  rclonePath: string
  defaultTimeoutMs: number
  verbose: boolean
  sinkAdapterRegistry: SinkAdapterRegistry
}

const DEFAULT_CONFIG: ResolvedConfig = {
  rclonePath: 'rclone',
  defaultTimeoutMs: 5 * 60 * 1000,
  verbose: false,
  sinkAdapterRegistry: defaultSinkAdapterRegistry,
}

export class RcloneSyncExecutor {
  private config: ResolvedConfig

  constructor(config?: RcloneSyncExecutorConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      sinkAdapterRegistry: config?.sinkAdapterRegistry ?? DEFAULT_CONFIG.sinkAdapterRegistry,
    }
  }

  /**
   * Get the sink adapter for a given sink configuration.
   */
  private getAdapter(sink: SinkConfig): SinkAdapter {
    return this.config.sinkAdapterRegistry.getAdapter(sink)
  }

  /**
   * Execute a sync operation for a mapping.
   *
   * @param tenantId - Tenant ID for path interpolation
   * @param mapping - Sync mapping configuration
   * @param sink - Sink configuration
   * @param containerVolumePath - Host path to the container's mounted volume
   */
  async sync(
    tenantId: TenantId,
    mapping: SyncMapping,
    sink: SinkConfig,
    containerVolumePath: string,
  ): Promise<SyncResult> {
    const startTime = Date.now()
    const adapter = this.getAdapter(sink)

    // Build local and remote paths
    const localPath = join(containerVolumePath, mapping.containerPath.replace(/^\//, ''))
    const remotePath = adapter.buildRemotePath(sink, tenantId, mapping.sinkPath)

    // Determine source and destination based on direction
    let source: string
    let destination: string

    switch (mapping.direction) {
      case 'upload':
        source = localPath
        destination = remotePath
        break
      case 'download':
        source = remotePath
        destination = localPath
        break
      case 'bidirectional':
        // Bidirectional uses bisync command instead
        return this.executeBisync(localPath, remotePath, mapping, sink, startTime)
    }

    // Build rclone arguments
    const args = this.buildSyncArgs(mapping, sink, source, destination)

    // Execute rclone
    return this.executeRclone(args, startTime)
  }

  /**
   * Execute upload sync (container → sink).
   */
  async upload(
    tenantId: TenantId,
    mapping: SyncMapping,
    sink: SinkConfig,
    containerVolumePath: string,
  ): Promise<SyncResult> {
    const uploadMapping: SyncMapping = { ...mapping, direction: 'upload' }
    return this.sync(tenantId, uploadMapping, sink, containerVolumePath)
  }

  /**
   * Execute download sync (sink → container).
   */
  async download(
    tenantId: TenantId,
    mapping: SyncMapping,
    sink: SinkConfig,
    containerVolumePath: string,
  ): Promise<SyncResult> {
    const downloadMapping: SyncMapping = { ...mapping, direction: 'download' }
    return this.sync(tenantId, downloadMapping, sink, containerVolumePath)
  }

  /**
   * Build rclone command arguments.
   */
  private buildSyncArgs(
    mapping: SyncMapping,
    sink: SinkConfig,
    source: string,
    destination: string,
  ): string[] {
    const adapter = this.getAdapter(sink)
    const args: string[] = []

    // Command: sync or copy
    args.push(mapping.mode)

    // Source and destination
    args.push(source)
    args.push(destination)

    // Sink-specific configuration
    args.push(...adapter.getRcloneArgs(sink))

    // Glob pattern support
    if (mapping.pattern) {
      args.push('--include', mapping.pattern)
      args.push('--exclude', '*')
    }

    // Common flags
    args.push('--progress')
    args.push('--stats-one-line')

    if (this.config.verbose) {
      args.push('-v')
    }

    // Add any custom rclone flags from sink config
    if (sink.rcloneFlags) {
      args.push(...sink.rcloneFlags)
    }

    return args
  }

  /**
   * Execute bidirectional sync using rclone bisync.
   */
  private async executeBisync(
    localPath: string,
    remotePath: string,
    mapping: SyncMapping,
    sink: SinkConfig,
    startTime: number,
  ): Promise<SyncResult> {
    const adapter = this.getAdapter(sink)
    const args: string[] = ['bisync', localPath, remotePath]

    // Sink-specific configuration
    args.push(...adapter.getRcloneArgs(sink))

    // Glob pattern support
    if (mapping.pattern) {
      args.push('--include', mapping.pattern)
      args.push('--exclude', '*')
    }

    // Bisync-specific flags
    args.push('--create-empty-src-dirs')
    args.push('--resilient')

    if (this.config.verbose) {
      args.push('-v')
    }

    // Add any custom rclone flags from sink config
    if (sink.rcloneFlags) {
      args.push(...sink.rcloneFlags)
    }

    return this.executeRclone(args, startTime)
  }

  /**
   * Execute rclone command and parse results.
   */
  private executeRclone(args: string[], startTime: number): Promise<SyncResult> {
    return new Promise((resolve) => {
      const errors: string[] = []
      let stdout = ''
      let stderr = ''

      const proc = spawn(this.config.rclonePath, args, {
        timeout: this.config.defaultTimeoutMs,
        env: {
          ...process.env,
          // Disable rclone prompts
          RCLONE_CONFIG_PASS: '',
        },
      })

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        const duration = Date.now() - startTime

        if (code === 0) {
          const stats = this.parseRcloneStats(stdout + stderr)
          resolve({
            success: true,
            bytesTransferred: stats.bytes,
            filesTransferred: stats.files,
            duration,
          })
        } else {
          // Extract error messages
          if (stderr) {
            errors.push(stderr.trim())
          }
          if (stdout.includes('ERROR')) {
            const errorLines = stdout.split('\n').filter((line) => line.includes('ERROR'))
            errors.push(...errorLines)
          }

          resolve({
            success: false,
            errors: errors.length > 0 ? errors : [`rclone exited with code ${code}`],
            duration,
          })
        }
      })

      proc.on('error', (err) => {
        resolve({
          success: false,
          errors: [err.message],
          duration: Date.now() - startTime,
        })
      })
    })
  }

  /**
   * Parse rclone stats output.
   */
  private parseRcloneStats(output: string): { bytes: number; files: number } {
    let bytes = 0
    let files = 0

    // Try to parse transferred stats
    // Format: "Transferred: 1.234 GiB / 1.234 GiB, 100%, 10.000 MiB/s, ETA 0s"
    const bytesMatch = output.match(/Transferred:\s*([0-9.]+)\s*(B|KiB|MiB|GiB|TiB)/i)
    if (bytesMatch) {
      const value = Number.parseFloat(bytesMatch[1])
      const unit = bytesMatch[2].toLowerCase()
      const multipliers: Record<string, number> = {
        b: 1,
        kib: 1024,
        mib: 1024 * 1024,
        gib: 1024 * 1024 * 1024,
        tib: 1024 * 1024 * 1024 * 1024,
      }
      bytes = Math.floor(value * (multipliers[unit] || 1))
    }

    // Try to parse file count
    // Format: "Transferred: 42 / 42, 100%"
    const filesMatch = output.match(/Transferred:\s*(\d+)\s*\/\s*\d+/)
    if (filesMatch) {
      files = Number.parseInt(filesMatch[1], 10)
    }

    return { bytes, files }
  }

  /**
   * Check if rclone is available.
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.config.rclonePath, ['version'], {
        timeout: 5000,
      })

      proc.on('close', (code) => {
        resolve(code === 0)
      })

      proc.on('error', () => {
        resolve(false)
      })
    })
  }

  /**
   * Get rclone version.
   */
  async getVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      let stdout = ''

      const proc = spawn(this.config.rclonePath, ['version'], {
        timeout: 5000,
      })

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          const versionMatch = stdout.match(/rclone\s+v?([0-9.]+)/)
          resolve(versionMatch ? versionMatch[1] : stdout.split('\n')[0])
        } else {
          resolve(null)
        }
      })

      proc.on('error', () => {
        resolve(null)
      })
    })
  }
}
