/**
 * S3 Sink Adapter
 *
 * Implements SinkAdapter for Amazon S3 storage.
 */

import type { S3SinkConfig, SinkConfig, TenantId } from '@boilerhouse/core'
import type { SinkAdapter } from '../sink-adapter'

/**
 * S3 sink adapter implementation.
 */
export class S3SinkAdapter implements SinkAdapter {
  readonly type = 's3'

  buildRemotePath(sink: SinkConfig, tenantId: TenantId, sinkPath: string): string {
    const s3Sink = sink as S3SinkConfig
    const prefix = this.interpolatePath(s3Sink.prefix, tenantId)
    const fullPath = this.joinPath(prefix, sinkPath)
    return `:s3:${s3Sink.bucket}/${fullPath}`
  }

  getRcloneArgs(sink: SinkConfig): string[] {
    const s3Sink = sink as S3SinkConfig
    const args: string[] = []

    args.push('--s3-provider', 'AWS')
    args.push('--s3-region', s3Sink.region)

    if (s3Sink.accessKeyId) {
      args.push('--s3-access-key-id', s3Sink.accessKeyId)
    }

    if (s3Sink.secretAccessKey) {
      args.push('--s3-secret-access-key', s3Sink.secretAccessKey)
    }

    // Use environment credentials if not provided
    if (!s3Sink.accessKeyId && !s3Sink.secretAccessKey) {
      args.push('--s3-env-auth')
    }

    return args
  }

  private interpolatePath(path: string, tenantId: TenantId): string {
    return path.replace(/\$\{tenantId\}/g, tenantId)
  }

  private joinPath(prefix: string, sinkPath: string): string {
    // Normalize: remove trailing slash from prefix, leading slash from sinkPath
    const normalizedPrefix = prefix.replace(/\/$/, '')
    const normalizedSinkPath = sinkPath.replace(/^\//, '')

    if (!normalizedPrefix) {
      return normalizedSinkPath
    }
    if (!normalizedSinkPath) {
      return normalizedPrefix
    }
    return `${normalizedPrefix}/${normalizedSinkPath}`
  }
}
