/**
 * @boilerhouse/db
 *
 * SQLite persistence layer for Boilerhouse using Drizzle ORM.
 * DB is the single source of truth for domain state.
 * Docker is the source of truth for container existence.
 *
 * Consumers use DrizzleDb + schema directly for queries.
 * Custom column types handle Date↔integer and JSON↔text conversion.
 * Branded ID types flow through from the schema.
 */

export {
  closeDatabase,
  createTestDatabase,
  initDatabase,
  type DatabaseConfig,
  type DrizzleDb,
} from './database'
export * as schema from './schema'

// Domain types inferred from schema (replaces old repository interfaces)
export type {
  containers,
  pools,
  syncStatus,
  syncErrors,
  activityLog,
} from './schema'

import type * as s from './schema'

export type ContainerRow = typeof s.containers.$inferSelect
export type ContainerInsert = typeof s.containers.$inferInsert
export type PoolRecord = typeof s.pools.$inferSelect
export type PoolRecordInsert = typeof s.pools.$inferInsert
export type SyncStatusEntry = typeof s.syncStatus.$inferSelect
export type SyncStatusInsert = typeof s.syncStatus.$inferInsert
export type SyncErrorEntry = typeof s.syncErrors.$inferSelect
export type SyncErrorInsert = typeof s.syncErrors.$inferInsert
export type ActivityEntry = typeof s.activityLog.$inferSelect
export type ActivityInsert = typeof s.activityLog.$inferInsert
