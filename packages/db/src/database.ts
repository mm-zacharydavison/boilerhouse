/**
 * Database Initialization
 *
 * Creates and configures the SQLite database with WAL mode for performance,
 * wrapped with Drizzle ORM for type-safe queries.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>

export interface DatabaseConfig {
  /** Path to the SQLite database file */
  path: string
  /** Enable WAL mode for better concurrent performance (default: true) */
  walMode?: boolean
  /** Enable foreign key constraints (default: true) */
  foreignKeys?: boolean
  /** Busy timeout in milliseconds (default: 5000) */
  busyTimeout?: number
  /** Path to drizzle migrations folder (default: resolved from package) */
  migrationsFolder?: string
}

const DEFAULT_CONFIG: Omit<DatabaseConfig, 'path'> = {
  walMode: true,
  foreignKeys: true,
  busyTimeout: 5000,
}

/**
 * Resolve the migrations folder path.
 * Finds the drizzle/ directory relative to the @boilerhouse/db package.
 */
function resolveMigrationsFolder(): string {
  const dbPackageDir = import.meta.dir.replace(/\/src$/, '')
  return `${dbPackageDir}/drizzle`
}

/**
 * Initialize the database with migrations and optimized settings.
 * Returns a Drizzle ORM instance wrapping the configured SQLite database.
 */
export function initDatabase(config: DatabaseConfig): DrizzleDb {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }

  // Ensure parent directory exists
  const dir = dirname(fullConfig.path)
  mkdirSync(dir, { recursive: true })

  console.log(`[DB] Opening database at ${fullConfig.path}`)

  const sqlite = new Database(fullConfig.path, { create: true })

  // Configure SQLite for optimal performance
  if (fullConfig.walMode) {
    sqlite.run('PRAGMA journal_mode = WAL')
    console.log('[DB] WAL mode enabled')
  }

  if (fullConfig.foreignKeys) {
    sqlite.run('PRAGMA foreign_keys = ON')
  }

  if (fullConfig.busyTimeout) {
    sqlite.run(`PRAGMA busy_timeout = ${fullConfig.busyTimeout}`)
  }

  // Additional performance pragmas
  sqlite.run('PRAGMA synchronous = NORMAL')
  sqlite.run('PRAGMA temp_store = MEMORY')
  sqlite.run('PRAGMA mmap_size = 268435456') // 256MB

  const db = drizzle(sqlite, { schema })

  // Run migrations
  const migrationsFolder = fullConfig.migrationsFolder ?? resolveMigrationsFolder()
  migrate(db, { migrationsFolder })
  console.log('[DB] Migrations applied')

  return db
}

/**
 * Create an in-memory Drizzle database for testing.
 * Applies migrations and returns the Drizzle instance.
 */
export function createTestDatabase(): DrizzleDb {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  const migrationsFolder = resolveMigrationsFolder()
  migrate(db, { migrationsFolder })
  return db
}

/**
 * Close the database connection gracefully.
 * Accesses the underlying SQLite client for WAL checkpoint and close.
 */
export function closeDatabase(db: DrizzleDb): void {
  console.log('[DB] Closing database...')

  // Access underlying bun:sqlite Database for checkpoint and close
  const raw = (db as unknown as { $client: Database }).$client

  // Checkpoint WAL before closing
  try {
    raw.run('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // Ignore errors during checkpoint
  }

  raw.close()
  console.log('[DB] Database closed')
}
