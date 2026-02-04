/**
 * S3SinkAdapter Unit Tests
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { S3SinkConfig, TenantId } from '@boilerhouse/core'
import { createS3SinkConfig, createTenantId } from '../../../test/fixtures'
import { S3SinkAdapter } from './s3'

describe('S3SinkAdapter', () => {
  let adapter: S3SinkAdapter

  beforeEach(() => {
    adapter = new S3SinkAdapter()
  })

  test('has correct type', () => {
    expect(adapter.type).toBe('s3')
  })

  describe('buildRemotePath', () => {
    test('builds correct S3 remote path', () => {
      const sink = createS3SinkConfig({
        bucket: 'my-bucket',
        prefix: 'data/',
      })
      const tenantId = 'tenant-123' as TenantId

      const path = adapter.buildRemotePath(sink, tenantId, 'files/')
      expect(path).toBe(':s3:my-bucket/data/files/')
    })

    test('interpolates tenantId in prefix', () => {
      const sink = createS3SinkConfig({
        bucket: 'my-bucket',
        prefix: 'tenants/${tenantId}/state',
      })
      const tenantId = 'tenant-abc' as TenantId

      const path = adapter.buildRemotePath(sink, tenantId, 'data')
      expect(path).toBe(':s3:my-bucket/tenants/tenant-abc/state/data')
    })

    test('handles empty prefix', () => {
      const sink = createS3SinkConfig({
        bucket: 'my-bucket',
        prefix: '',
      })

      const path = adapter.buildRemotePath(sink, createTenantId(), 'data/')
      expect(path).toBe(':s3:my-bucket/data/')
    })

    test('handles empty sinkPath', () => {
      const sink = createS3SinkConfig({
        bucket: 'my-bucket',
        prefix: 'prefix/',
      })

      const path = adapter.buildRemotePath(sink, createTenantId(), '')
      expect(path).toBe(':s3:my-bucket/prefix')
    })

    test('normalizes slashes', () => {
      const sink = createS3SinkConfig({
        bucket: 'my-bucket',
        prefix: 'prefix/',
      })

      const path = adapter.buildRemotePath(sink, createTenantId(), '/data/')
      expect(path).toBe(':s3:my-bucket/prefix/data/')
    })
  })

  describe('getRcloneArgs', () => {
    test('includes provider and region', () => {
      const sink = createS3SinkConfig({ region: 'eu-west-1' })

      const args = adapter.getRcloneArgs(sink)

      expect(args).toContain('--s3-provider')
      expect(args).toContain('AWS')
      expect(args).toContain('--s3-region')
      expect(args).toContain('eu-west-1')
    })

    test('includes credentials when provided', () => {
      const sink = createS3SinkConfig({
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secret123',
      })

      const args = adapter.getRcloneArgs(sink)

      expect(args).toContain('--s3-access-key-id')
      expect(args).toContain('AKIATEST')
      expect(args).toContain('--s3-secret-access-key')
      expect(args).toContain('secret123')
    })

    test('uses env auth when no credentials provided', () => {
      const sink: S3SinkConfig = {
        type: 's3',
        bucket: 'test',
        region: 'us-east-1',
        prefix: '',
        accessKeyId: undefined,
        secretAccessKey: undefined,
      }

      const args = adapter.getRcloneArgs(sink)

      expect(args).toContain('--s3-env-auth')
      expect(args).not.toContain('--s3-access-key-id')
      expect(args).not.toContain('--s3-secret-access-key')
    })
  })
})
