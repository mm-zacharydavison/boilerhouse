import { Database } from 'bun:sqlite'
import { runMigrations } from '@boilerhouse/db'

export function createTestDb() {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}
