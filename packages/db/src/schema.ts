/**
 * Drizzle ORM Schema
 *
 * Defines all database tables with custom column types for automatic
 * Date↔integer and JSON↔text conversion. Branded ID types from
 * @boilerhouse/core are applied via $type<>() for type safety.
 */

import type { ContainerId, PoolId, SyncId, TenantId, WorkloadId } from '@boilerhouse/core'
import { customType, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Custom column type: stores Date as integer (epoch ms) in SQLite.
 * Nullable columns just omit .notNull() — Drizzle handles null passthrough.
 */
const timestamp = customType<{ data: Date; driverData: number }>({
  dataType() {
    return 'integer'
  },
  toDriver(value: Date): number {
    return value.getTime()
  },
  fromDriver(value: number): Date {
    return new Date(value)
  },
})

/**
 * Custom column type: stores Record<string, unknown> as JSON text in SQLite.
 */
const jsonObject = customType<{ data: Record<string, unknown>; driverData: string }>({
  dataType() {
    return 'text'
  },
  toDriver(value: Record<string, unknown>): string {
    return JSON.stringify(value)
  },
  fromDriver(value: string): Record<string, unknown> {
    return JSON.parse(value) as Record<string, unknown>
  },
})

/**
 * Custom column type: stores string[] as JSON text in SQLite.
 */
const jsonStringArray = customType<{ data: string[]; driverData: string }>({
  dataType() {
    return 'text'
  },
  toDriver(value: string[]): string {
    return JSON.stringify(value)
  },
  fromDriver(value: string): string[] {
    return JSON.parse(value) as string[]
  },
})

export const containers = sqliteTable(
  'containers',
  {
    containerId: text('container_id').$type<ContainerId>().primaryKey(),
    poolId: text('pool_id').$type<PoolId>().notNull(),
    status: text('status', {
      enum: ['idle', 'claimed', 'stopping'],
    }).notNull(),
    tenantId: text('tenant_id').$type<TenantId>(),
    lastTenantId: text('last_tenant_id').$type<TenantId>(),
    lastActivity: timestamp('last_activity').notNull(),
    claimedAt: timestamp('claimed_at'),
    idleExpiresAt: timestamp('idle_expires_at'),
    createdAt: timestamp('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_containers_pool').on(table.poolId),
    index('idx_containers_status').on(table.poolId, table.status),
    index('idx_containers_tenant').on(table.tenantId),
  ],
)

export const pools = sqliteTable('pools', {
  poolId: text('pool_id').$type<PoolId>().primaryKey(),
  workloadId: text('workload_id').$type<WorkloadId>().notNull(),
  minSize: integer('min_size').notNull(),
  maxSize: integer('max_size').notNull(),
  idleTimeoutMs: integer('idle_timeout_ms').notNull(),
  evictionIntervalMs: integer('eviction_interval_ms').notNull(),
  acquireTimeoutMs: integer('acquire_timeout_ms').notNull(),
  networks: jsonStringArray('networks'),
  fileIdleTtl: integer('file_idle_ttl'),
  createdAt: timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
})

export const syncStatus = sqliteTable(
  'sync_status',
  {
    tenantId: text('tenant_id').$type<TenantId>().notNull(),
    syncId: text('sync_id').$type<SyncId>().notNull(),
    lastSyncAt: timestamp('last_sync_at'),
    pendingCount: integer('pending_count').notNull().default(0),
    state: text('state', { enum: ['idle', 'syncing', 'error'] }).notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.syncId] })],
)

export const syncErrors = sqliteTable(
  'sync_errors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenantId: text('tenant_id').$type<TenantId>().notNull(),
    syncId: text('sync_id').$type<SyncId>().notNull(),
    message: text('message').notNull(),
    mapping: text('mapping'),
    timestamp: timestamp('timestamp').notNull(),
  },
  (table) => [index('idx_sync_errors_tenant_sync').on(table.tenantId, table.syncId)],
)

export const activityLog = sqliteTable(
  'activity_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventType: text('event_type').notNull(),
    poolId: text('pool_id').$type<PoolId>(),
    containerId: text('container_id').$type<ContainerId>(),
    tenantId: text('tenant_id').$type<TenantId>(),
    message: text('message').notNull(),
    metadata: jsonObject('metadata'),
    timestamp: timestamp('timestamp').notNull(),
  },
  (table) => [
    index('idx_activity_log_timestamp').on(table.timestamp),
    index('idx_activity_log_event_type').on(table.eventType),
  ],
)
