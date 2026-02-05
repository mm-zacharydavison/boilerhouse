/**
 * Migration 001: Initial Schema
 *
 * Creates all tables for durability:
 * - claims: Tenant-to-container claims
 * - pools: Pool configurations
 * - affinity_reservations: Tenant affinity reservations
 * - sync_status: Sync operation status
 * - sync_errors: Sync error history
 * - activity_log: Activity event log (auto-trimmed)
 */

import type { Database } from 'bun:sqlite'

export const version = 1

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS claims (
      container_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      pool_id TEXT NOT NULL,
      last_activity INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_claims_tenant ON claims(tenant_id)
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_claims_pool ON claims(pool_id)
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS pools (
      pool_id TEXT PRIMARY KEY,
      workload_id TEXT NOT NULL,
      min_size INTEGER NOT NULL,
      max_size INTEGER NOT NULL,
      idle_timeout_ms INTEGER NOT NULL,
      eviction_interval_ms INTEGER NOT NULL,
      acquire_timeout_ms INTEGER NOT NULL,
      network_name TEXT,
      affinity_timeout_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS affinity_reservations (
      tenant_id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      pool_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_affinity_expires_at ON affinity_reservations(expires_at)
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_status (
      tenant_id TEXT NOT NULL,
      sync_id TEXT NOT NULL,
      last_sync_at INTEGER,
      pending_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('idle', 'syncing', 'error')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, sync_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      sync_id TEXT NOT NULL,
      message TEXT NOT NULL,
      mapping TEXT,
      timestamp INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sync_errors_tenant_sync ON sync_errors(tenant_id, sync_id)
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      pool_id TEXT,
      container_id TEXT,
      tenant_id TEXT,
      message TEXT NOT NULL,
      metadata TEXT,
      timestamp INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp DESC)
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_event_type ON activity_log(event_type)
  `)
}

export function down(db: Database): void {
  db.run('DROP TABLE IF EXISTS activity_log')
  db.run('DROP TABLE IF EXISTS sync_errors')
  db.run('DROP TABLE IF EXISTS sync_status')
  db.run('DROP TABLE IF EXISTS affinity_reservations')
  db.run('DROP TABLE IF EXISTS pools')
  db.run('DROP TABLE IF EXISTS claims')
}
