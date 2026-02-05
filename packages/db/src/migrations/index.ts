/**
 * Migration Runner
 *
 * Applies database migrations in order, tracking which have been applied.
 */

import type { Database } from 'bun:sqlite'
import * as migration001 from './001-initial-schema'

export interface Migration {
  version: number
  up: (db: Database) => void
  down: (db: Database) => void
}

const migrations: Migration[] = [
  {
    version: migration001.version,
    up: migration001.up,
    down: migration001.down,
  },
]

/**
 * Get the current schema version from the database.
 */
function getCurrentVersion(db: Database): number {
  try {
    const result = db
      .query<{ version: number }, []>('SELECT MAX(version) as version FROM schema_version')
      .get()
    return result?.version ?? 0
  } catch {
    return 0
  }
}

/**
 * Initialize the schema_version table.
 */
function initSchemaVersionTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
}

/**
 * Run all pending migrations.
 */
export function runMigrations(db: Database): { applied: number[]; current: number } {
  initSchemaVersionTable(db)

  const currentVersion = getCurrentVersion(db)
  const pendingMigrations = migrations.filter((m) => m.version > currentVersion)
  const applied: number[] = []

  for (const migration of pendingMigrations) {
    console.log(`[DB] Applying migration ${migration.version}...`)

    db.transaction(() => {
      migration.up(db)
      db.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
        migration.version,
        Date.now(),
      ])
    })()

    applied.push(migration.version)
    console.log(`[DB] Migration ${migration.version} applied`)
  }

  return {
    applied,
    current: applied.length > 0 ? applied[applied.length - 1] : currentVersion,
  }
}

/**
 * Rollback the last migration.
 */
export function rollbackMigration(db: Database): number | null {
  const currentVersion = getCurrentVersion(db)
  if (currentVersion === 0) {
    return null
  }

  const migration = migrations.find((m) => m.version === currentVersion)
  if (!migration) {
    throw new Error(`Migration ${currentVersion} not found`)
  }

  console.log(`[DB] Rolling back migration ${currentVersion}...`)

  db.transaction(() => {
    migration.down(db)
    db.run('DELETE FROM schema_version WHERE version = ?', [currentVersion])
  })()

  console.log(`[DB] Migration ${currentVersion} rolled back`)
  return currentVersion
}

/**
 * Get list of all migrations and their status.
 */
export function getMigrationStatus(db: Database): Array<{ version: number; applied: boolean }> {
  initSchemaVersionTable(db)

  const appliedVersions = new Set<number>()
  const rows = db.query<{ version: number }, []>('SELECT version FROM schema_version').all()
  for (const row of rows) {
    appliedVersions.add(row.version)
  }

  return migrations.map((m) => ({
    version: m.version,
    applied: appliedVersions.has(m.version),
  }))
}
