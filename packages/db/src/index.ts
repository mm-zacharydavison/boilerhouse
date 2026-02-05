/**
 * @boilerhouse/db
 *
 * SQLite persistence layer for Boilerhouse.
 * DB is the single source of truth for domain state.
 * Docker is the source of truth for container existence.
 */

export { closeDatabase, initDatabase, type DatabaseConfig } from './database'
export { getMigrationStatus, rollbackMigration, runMigrations } from './migrations'
export {
  ActivityRepository,
  AffinityRepository,
  ClaimRepository,
  PoolRepository,
  SyncStatusRepository,
  type ActivityEntry,
  type AffinityReservation,
  type Claim,
  type PoolRecord,
  type SyncErrorEntry,
  type SyncStatusEntry,
} from './repositories'
export type {
  ActivityLogRow,
  AffinityReservationRow,
  ClaimRow,
  PoolRow,
  SchemaVersionRow,
  SyncErrorRow,
  SyncStatusRow,
} from './types'
