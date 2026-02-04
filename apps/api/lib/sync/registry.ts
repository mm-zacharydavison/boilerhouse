/**
 * Sync Registry
 *
 * In-memory registry for SyncSpec configurations.
 * Provides CRUD operations for managing sync specifications per pool.
 */

import type { PoolId, SyncId, SyncSpec } from '@boilerhouse/core'

export class SyncRegistry {
  private specs: Map<SyncId, SyncSpec> = new Map()
  private byPoolId: Map<PoolId, Set<SyncId>> = new Map()

  /**
   * Register a new sync specification.
   * @throws Error if a spec with the same ID already exists
   */
  register(spec: SyncSpec): void {
    if (this.specs.has(spec.id)) {
      throw new Error(`SyncSpec with id '${spec.id}' already exists`)
    }

    this.specs.set(spec.id, spec)

    // Index by pool ID
    let poolSet = this.byPoolId.get(spec.poolId)
    if (!poolSet) {
      poolSet = new Set()
      this.byPoolId.set(spec.poolId, poolSet)
    }
    poolSet.add(spec.id)
  }

  /**
   * Get a sync spec by ID.
   */
  get(id: SyncId): SyncSpec | undefined {
    return this.specs.get(id)
  }

  /**
   * Get all sync specs for a pool.
   */
  getByPoolId(poolId: PoolId): SyncSpec[] {
    const syncIds = this.byPoolId.get(poolId)
    if (!syncIds) {
      return []
    }

    return Array.from(syncIds)
      .map((id) => this.specs.get(id))
      .filter((spec): spec is SyncSpec => spec !== undefined)
  }

  /**
   * Update an existing sync spec.
   * @throws Error if the spec does not exist
   */
  update(id: SyncId, updates: Partial<Omit<SyncSpec, 'id'>>): SyncSpec {
    const existing = this.specs.get(id)
    if (!existing) {
      throw new Error(`SyncSpec with id '${id}' not found`)
    }

    // If poolId is changing, update the index
    if (updates.poolId && updates.poolId !== existing.poolId) {
      // Remove from old pool index
      const oldPoolSyncIds = this.byPoolId.get(existing.poolId)
      if (oldPoolSyncIds) {
        oldPoolSyncIds.delete(id)
        if (oldPoolSyncIds.size === 0) {
          this.byPoolId.delete(existing.poolId)
        }
      }

      // Add to new pool index
      let newPoolSet = this.byPoolId.get(updates.poolId)
      if (!newPoolSet) {
        newPoolSet = new Set()
        this.byPoolId.set(updates.poolId, newPoolSet)
      }
      newPoolSet.add(id)
    }

    const updated: SyncSpec = {
      ...existing,
      ...updates,
      id, // Ensure ID cannot be changed
    }

    this.specs.set(id, updated)
    return updated
  }

  /**
   * Remove a sync spec.
   * @returns true if the spec was removed, false if it didn't exist
   */
  remove(id: SyncId): boolean {
    const spec = this.specs.get(id)
    if (!spec) {
      return false
    }

    // Remove from pool index
    const poolSyncIds = this.byPoolId.get(spec.poolId)
    if (poolSyncIds) {
      poolSyncIds.delete(id)
      if (poolSyncIds.size === 0) {
        this.byPoolId.delete(spec.poolId)
      }
    }

    this.specs.delete(id)
    return true
  }

  /**
   * List all sync specs.
   */
  list(): SyncSpec[] {
    return Array.from(this.specs.values())
  }

  /**
   * Check if a sync spec exists.
   */
  has(id: SyncId): boolean {
    return this.specs.has(id)
  }

  /**
   * Get the number of registered sync specs.
   */
  size(): number {
    return this.specs.size
  }

  /**
   * Clear all registered sync specs.
   */
  clear(): void {
    this.specs.clear()
    this.byPoolId.clear()
  }
}
