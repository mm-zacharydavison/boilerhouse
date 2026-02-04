/**
 * RcloneSyncExecutor Unit Tests
 */

import { describe, expect, mock, test } from 'bun:test'
import { createS3SinkConfig, createSyncMapping, createTenantId } from '../../test/fixtures'
import { RcloneSyncExecutor } from './rclone'
import { SinkAdapterRegistry } from './sink-adapter'

describe('RcloneSyncExecutor', () => {
  describe('constructor', () => {
    test('uses default config when none provided', () => {
      const executor = new RcloneSyncExecutor()

      const config = (executor as unknown as { config: { rclonePath: string } }).config

      expect(config.rclonePath).toBe('rclone')
    })

    test('merges custom config with defaults', () => {
      const executor = new RcloneSyncExecutor({
        rclonePath: '/custom/rclone',
        verbose: true,
      })

      const config = (
        executor as unknown as {
          config: { rclonePath: string; verbose: boolean; defaultTimeoutMs: number }
        }
      ).config

      expect(config.rclonePath).toBe('/custom/rclone')
      expect(config.verbose).toBe(true)
      expect(config.defaultTimeoutMs).toBe(5 * 60 * 1000) // Default
    })

    test('accepts custom sink adapter registry', () => {
      const customRegistry = new SinkAdapterRegistry()
      const executor = new RcloneSyncExecutor({
        sinkAdapterRegistry: customRegistry,
      })

      const config = (
        executor as unknown as { config: { sinkAdapterRegistry: SinkAdapterRegistry } }
      ).config

      expect(config.sinkAdapterRegistry).toBe(customRegistry)
    })
  })

  describe('parseRcloneStats', () => {
    function parseStats(executor: RcloneSyncExecutor, output: string) {
      return (
        executor as unknown as { parseRcloneStats: (o: string) => { bytes: number; files: number } }
      ).parseRcloneStats(output)
    }

    test('parses bytes in B', () => {
      const executor = new RcloneSyncExecutor()
      const stats = parseStats(executor, 'Transferred: 512 B / 512 B, 100%')

      expect(stats.bytes).toBe(512)
    })

    test('parses bytes in KiB', () => {
      const executor = new RcloneSyncExecutor()
      const stats = parseStats(executor, 'Transferred: 2.5 KiB / 2.5 KiB, 100%')

      expect(stats.bytes).toBe(Math.floor(2.5 * 1024))
    })

    test('parses bytes in MiB', () => {
      const executor = new RcloneSyncExecutor()
      const stats = parseStats(executor, 'Transferred: 10.5 MiB / 10.5 MiB, 100%')

      expect(stats.bytes).toBe(Math.floor(10.5 * 1024 * 1024))
    })

    test('parses bytes in GiB', () => {
      const executor = new RcloneSyncExecutor()
      const stats = parseStats(executor, 'Transferred: 1.234 GiB / 1.234 GiB, 100%')

      expect(stats.bytes).toBe(Math.floor(1.234 * 1024 * 1024 * 1024))
    })

    test('parses bytes in TiB', () => {
      const executor = new RcloneSyncExecutor()
      const stats = parseStats(executor, 'Transferred: 0.5 TiB / 0.5 TiB, 100%')

      expect(stats.bytes).toBe(Math.floor(0.5 * 1024 * 1024 * 1024 * 1024))
    })

    test('parses file count', () => {
      const executor = new RcloneSyncExecutor()
      const stats = parseStats(executor, 'Transferred: 42 / 50, 84%')

      expect(stats.files).toBe(42)
    })

    test('returns zeros for unparseable output', () => {
      const executor = new RcloneSyncExecutor()
      const stats = parseStats(executor, 'No matching pattern')

      expect(stats.bytes).toBe(0)
      expect(stats.files).toBe(0)
    })

    test('handles combined output', () => {
      const executor = new RcloneSyncExecutor()
      const output = `
Transferred:   1.234 GiB / 1.234 GiB, 100%, 10.000 MiB/s, ETA 0s
Transferred:        42 / 42, 100%
`
      const stats = parseStats(executor, output)

      expect(stats.bytes).toBe(Math.floor(1.234 * 1024 * 1024 * 1024))
      expect(stats.files).toBe(42)
    })
  })

  describe('buildSyncArgs', () => {
    function buildArgs(
      executor: RcloneSyncExecutor,
      mapping: ReturnType<typeof createSyncMapping>,
      sink: ReturnType<typeof createS3SinkConfig>,
      source: string,
      destination: string,
    ) {
      return (
        executor as unknown as {
          buildSyncArgs: (m: typeof mapping, s: typeof sink, src: string, dst: string) => string[]
        }
      ).buildSyncArgs(mapping, sink, source, destination)
    }

    test('includes mode as first argument', () => {
      const executor = new RcloneSyncExecutor()
      const mapping = createSyncMapping({ mode: 'sync' })
      const sink = createS3SinkConfig()

      const args = buildArgs(executor, mapping, sink, '/local', ':s3:bucket/remote')

      expect(args[0]).toBe('sync')
    })

    test('includes source and destination', () => {
      const executor = new RcloneSyncExecutor()
      const mapping = createSyncMapping({ mode: 'copy' })
      const sink = createS3SinkConfig()

      const args = buildArgs(executor, mapping, sink, '/local/path', ':s3:bucket/remote')

      expect(args).toContain('/local/path')
      expect(args).toContain(':s3:bucket/remote')
    })

    test('includes sink-specific args', () => {
      const executor = new RcloneSyncExecutor()
      const mapping = createSyncMapping()
      const sink = createS3SinkConfig({ region: 'ap-northeast-1' })

      const args = buildArgs(executor, mapping, sink, '/local', ':s3:bucket/remote')

      expect(args).toContain('--s3-region')
      expect(args).toContain('ap-northeast-1')
    })

    test('includes pattern filter when specified', () => {
      const executor = new RcloneSyncExecutor()
      const mapping = createSyncMapping({ pattern: '*.json' })
      const sink = createS3SinkConfig()

      const args = buildArgs(executor, mapping, sink, '/local', ':s3:bucket/remote')

      expect(args).toContain('--include')
      expect(args).toContain('*.json')
      expect(args).toContain('--exclude')
      expect(args).toContain('*')
    })

    test('includes common flags', () => {
      const executor = new RcloneSyncExecutor()
      const mapping = createSyncMapping()
      const sink = createS3SinkConfig()

      const args = buildArgs(executor, mapping, sink, '/local', ':s3:bucket/remote')

      expect(args).toContain('--progress')
      expect(args).toContain('--stats-one-line')
    })

    test('includes verbose flag when enabled', () => {
      const executor = new RcloneSyncExecutor({ verbose: true })
      const mapping = createSyncMapping()
      const sink = createS3SinkConfig()

      const args = buildArgs(executor, mapping, sink, '/local', ':s3:bucket/remote')

      expect(args).toContain('-v')
    })

    test('excludes verbose flag when disabled', () => {
      const executor = new RcloneSyncExecutor({ verbose: false })
      const mapping = createSyncMapping()
      const sink = createS3SinkConfig()

      const args = buildArgs(executor, mapping, sink, '/local', ':s3:bucket/remote')

      expect(args).not.toContain('-v')
    })

    test('includes custom rclone flags from sink', () => {
      const executor = new RcloneSyncExecutor()
      const mapping = createSyncMapping()
      const sink = createS3SinkConfig({
        rcloneFlags: ['--s3-upload-cutoff=100M', '--fast-list'],
      })

      const args = buildArgs(executor, mapping, sink, '/local', ':s3:bucket/remote')

      expect(args).toContain('--s3-upload-cutoff=100M')
      expect(args).toContain('--fast-list')
    })
  })

  describe('upload', () => {
    test('calls sync with upload direction', async () => {
      const executor = new RcloneSyncExecutor()
      const syncSpy = mock(() => Promise.resolve({ success: true, duration: 100 }))
      ;(executor as unknown as { sync: typeof syncSpy }).sync = syncSpy

      const mapping = createSyncMapping({ direction: 'download' }) // Original direction
      const sink = createS3SinkConfig()

      await executor.upload(createTenantId(), mapping, sink, '/volume')

      expect(syncSpy).toHaveBeenCalled()
      const calls = syncSpy.mock.calls as unknown as Array<[unknown, { direction: string }]>
      expect(calls[0][1].direction).toBe('upload')
    })
  })

  describe('download', () => {
    test('calls sync with download direction', async () => {
      const executor = new RcloneSyncExecutor()
      const syncSpy = mock(() => Promise.resolve({ success: true, duration: 100 }))
      ;(executor as unknown as { sync: typeof syncSpy }).sync = syncSpy

      const mapping = createSyncMapping({ direction: 'upload' }) // Original direction
      const sink = createS3SinkConfig()

      await executor.download(createTenantId(), mapping, sink, '/volume')

      expect(syncSpy).toHaveBeenCalled()
      const calls = syncSpy.mock.calls as unknown as Array<[unknown, { direction: string }]>
      expect(calls[0][1].direction).toBe('download')
    })
  })
})
