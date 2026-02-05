/**
 * @boilerhouse/db
 *
 * SQLite persistence layer for Boilerhouse.
 * Provides write-through caching: in-memory structures remain primary,
 * SQLite provides durability and crash recovery.
 */

export { closeDatabase, initDatabase, type DatabaseConfig } from './database'
export { getMigrationStatus, rollbackMigration, runMigrations } from './migrations'
export {
  ActivityRepository,
  AffinityRepository,
  ContainerRepository,
  SyncStatusRepository,
  type ActivityEntry,
  type AffinityReservation,
  type SyncErrorEntry,
  type SyncStatusEntry,
} from './repositories'
export type {
  ActivityLogRow,
  AffinityReservationRow,
  ContainerRow,
  SchemaVersionRow,
  SyncErrorRow,
  SyncStatusRow,
} from './types'
