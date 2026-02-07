/**
 * SinkAdapterRegistry Unit Tests
 */

import { describe, expect, test } from 'bun:test'
import { type SinkConfig, TenantId } from '@boilerhouse/core'
import { createS3SinkConfig } from '../../test/fixtures'
import { type SinkAdapter, SinkAdapterRegistry } from './sink-adapter'

describe('SinkAdapterRegistry', () => {
  test('has S3 adapter registered by default', () => {
    const registry = new SinkAdapterRegistry()

    expect(registry.hasAdapter('s3')).toBe(true)
  })

  test('getAdapter returns correct adapter for sink type', () => {
    const registry = new SinkAdapterRegistry()
    const sink = createS3SinkConfig()

    const adapter = registry.getAdapter(sink)

    expect(adapter.type).toBe('s3')
  })

  test('getAdapter throws for unknown sink type', () => {
    const registry = new SinkAdapterRegistry()
    const unknownSink = { type: 'gcs' } as unknown as SinkConfig

    expect(() => registry.getAdapter(unknownSink)).toThrow(
      "No adapter registered for sink type 'gcs'",
    )
  })

  test('register adds new adapter', () => {
    const registry = new SinkAdapterRegistry()
    const mockAdapter: SinkAdapter = {
      type: 'gcs',
      buildRemotePath: () => ':gcs:bucket/path',
      getRcloneArgs: () => ['--gcs-flag'],
    }

    registry.register(mockAdapter)

    expect(registry.hasAdapter('gcs')).toBe(true)
    expect(registry.getAdapter({ type: 'gcs' } as unknown as SinkConfig)).toBe(mockAdapter)
  })

  test('register overwrites existing adapter', () => {
    const registry = new SinkAdapterRegistry()
    const customS3Adapter: SinkAdapter = {
      type: 's3',
      buildRemotePath: () => 'custom-path',
      getRcloneArgs: () => ['--custom-flag'],
    }

    registry.register(customS3Adapter)
    const sink = createS3SinkConfig()

    expect(registry.getAdapter(sink).buildRemotePath(sink, TenantId('tenant'), 'path')).toBe(
      'custom-path',
    )
  })
})
