/**
 * SyncRegistry Unit Tests
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { PoolId, SyncId } from '@boilerhouse/core'
import { createPoolId, createSyncId, createSyncSpec } from '../../test/fixtures'
import { SyncRegistry } from './registry'

describe('SyncRegistry', () => {
  let registry: SyncRegistry

  beforeEach(() => {
    registry = new SyncRegistry()
  })

  describe('register', () => {
    test('registers a new sync spec', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      expect(registry.get(spec.id)).toEqual(spec)
      expect(registry.size()).toBe(1)
    })

    test('throws error if spec with same ID exists', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      expect(() => registry.register(spec)).toThrow(`SyncSpec with id '${spec.id}' already exists`)
    })

    test('indexes spec by pool ID', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      const byPool = registry.getByPoolId(spec.poolId)
      expect(byPool).toHaveLength(1)
      expect(byPool[0].id).toBe(spec.id)
    })
  })

  describe('get', () => {
    test('returns undefined for non-existent ID', () => {
      expect(registry.get(createSyncId())).toBeUndefined()
    })

    test('returns registered spec', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      expect(registry.get(spec.id)).toEqual(spec)
    })
  })

  describe('getByPoolId', () => {
    test('returns empty array for non-existent pool', () => {
      expect(registry.getByPoolId(createPoolId())).toEqual([])
    })

    test('returns all specs for a pool', () => {
      const poolId = createPoolId()
      const spec1 = createSyncSpec({ poolId })
      const spec2 = createSyncSpec({ poolId })
      const spec3 = createSyncSpec({ poolId: createPoolId() })

      registry.register(spec1)
      registry.register(spec2)
      registry.register(spec3)

      const byPool = registry.getByPoolId(poolId)
      expect(byPool).toHaveLength(2)
      expect(byPool.map((s) => s.id)).toContain(spec1.id)
      expect(byPool.map((s) => s.id)).toContain(spec2.id)
    })
  })

  describe('update', () => {
    test('updates existing spec', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      const updated = registry.update(spec.id, {
        policy: { ...spec.policy, intervalMs: 60000 },
      })

      expect(updated.policy.intervalMs).toBe(60000)
      expect(registry.get(spec.id)?.policy.intervalMs).toBe(60000)
    })

    test('throws error for non-existent ID', () => {
      const nonExistentId = createSyncId()
      expect(() => registry.update(nonExistentId, {})).toThrow(
        `SyncSpec with id '${nonExistentId}' not found`,
      )
    })

    test('updates pool index when poolId changes', () => {
      const oldPoolId = createPoolId()
      const newPoolId = createPoolId()
      const spec = createSyncSpec({ poolId: oldPoolId })
      registry.register(spec)

      registry.update(spec.id, { poolId: newPoolId })

      expect(registry.getByPoolId(oldPoolId)).toHaveLength(0)
      expect(registry.getByPoolId(newPoolId)).toHaveLength(1)
    })

    test('cannot change ID via update', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      const updated = registry.update(spec.id, {})
      expect(updated.id).toBe(spec.id)
    })
  })

  describe('remove', () => {
    test('removes existing spec', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      expect(registry.remove(spec.id)).toBe(true)
      expect(registry.get(spec.id)).toBeUndefined()
      expect(registry.size()).toBe(0)
    })

    test('returns false for non-existent ID', () => {
      expect(registry.remove(createSyncId())).toBe(false)
    })

    test('removes from pool index', () => {
      const spec = createSyncSpec()
      registry.register(spec)
      registry.remove(spec.id)

      expect(registry.getByPoolId(spec.poolId)).toHaveLength(0)
    })
  })

  describe('list', () => {
    test('returns all registered specs', () => {
      const spec1 = createSyncSpec()
      const spec2 = createSyncSpec()

      registry.register(spec1)
      registry.register(spec2)

      const all = registry.list()
      expect(all).toHaveLength(2)
    })

    test('returns empty array when empty', () => {
      expect(registry.list()).toEqual([])
    })
  })

  describe('has', () => {
    test('returns true for existing spec', () => {
      const spec = createSyncSpec()
      registry.register(spec)

      expect(registry.has(spec.id)).toBe(true)
    })

    test('returns false for non-existent spec', () => {
      expect(registry.has(createSyncId())).toBe(false)
    })
  })

  describe('clear', () => {
    test('removes all specs', () => {
      registry.register(createSyncSpec())
      registry.register(createSyncSpec())

      registry.clear()

      expect(registry.size()).toBe(0)
      expect(registry.list()).toEqual([])
    })
  })
})
