/**
 * Database Initialization
 *
 * Creates and configures the SQLite database with WAL mode for performance.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations } from './migrations'

export interface DatabaseConfig {
  /** Path to the SQLite database file */
  path: string
  /** Enable WAL mode for better concurrent performance (default: true) */
  walMode?: boolean
  /** Enable foreign key constraints (default: true) */
  foreignKeys?: boolean
  /** Busy timeout in milliseconds (default: 5000) */
  busyTimeout?: number
}

const DEFAULT_CONFIG: Omit<DatabaseConfig, 'path'> = {
  walMode: true,
  foreignKeys: true,
  busyTimeout: 5000,
}

/**
 * Initialize the database with migrations and optimized settings.
 */
export function initDatabase(config: DatabaseConfig): Database {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }

  // Ensure parent directory exists
  const dir = dirname(fullConfig.path)
  mkdirSync(dir, { recursive: true })

  console.log(`[DB] Opening database at ${fullConfig.path}`)

  const db = new Database(fullConfig.path, { create: true })

  // Configure SQLite for optimal performance
  if (fullConfig.walMode) {
    db.run('PRAGMA journal_mode = WAL')
    console.log('[DB] WAL mode enabled')
  }

  if (fullConfig.foreignKeys) {
    db.run('PRAGMA foreign_keys = ON')
  }

  if (fullConfig.busyTimeout) {
    db.run(`PRAGMA busy_timeout = ${fullConfig.busyTimeout}`)
  }

  // Additional performance pragmas
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA temp_store = MEMORY')
  db.run('PRAGMA mmap_size = 268435456') // 256MB

  // Run migrations
  const { applied, current } = runMigrations(db)
  if (applied.length > 0) {
    console.log(`[DB] Applied ${applied.length} migration(s), now at version ${current}`)
  } else {
    console.log(`[DB] Database at version ${current}, no migrations needed`)
  }

  return db
}

/**
 * Close the database connection gracefully.
 */
export function closeDatabase(db: Database): void {
  console.log('[DB] Closing database...')

  // Checkpoint WAL before closing
  try {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // Ignore errors during checkpoint
  }

  db.close()
  console.log('[DB] Database closed')
}
