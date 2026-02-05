# Durability Plan

This document outlines how Boilerhouse can survive restarts and recover state for scheduled sync jobs, tenant assignments, and container pools.

## Current State

### Implementation Status

| Feature                          | Status         | Notes                                                    |
|----------------------------------|----------------|----------------------------------------------------------|
| WorkloadRegistry YAML loading    | ✅ Implemented | Loads from `config/workloads/*.yaml` on startup          |
| Docker labels on create          | ✅ Implemented | Sets `pool-id`, `managed`, `container-id`, `workload-id` |
| Docker label for tenant-id       | ❌ Not done    | Not updated when container is assigned                   |
| SyncRegistry                     | ❌ Not done    | Sync config embedded in WorkloadSpec.sync instead        |
| Container state recovery         | ❌ Not done    | No recovery on restart                                   |
| Graceful shutdown                | ❌ Not done    | No final sync on shutdown                                |

### In-Memory State Inventory

The following components hold state that would be lost on restart:

| Component          | State                                   | Impact of Loss                                | Priority |
|--------------------|-----------------------------------------|-----------------------------------------------|----------|
| ContainerManager   | `containers` Map (all container state)  | All container metadata lost                   | Critical |
| ContainerPool      | `assignedContainers` Map                | Unknown which tenant owns which container     | Critical |
| ContainerPool      | `affinityContainers` Map                | Tenants can't return to previous containers   | Critical |
| ContainerPool      | `affinityTimeouts` Map                  | Affinity reservation timers lost              | High     |
| PoolRegistry       | `pools` Map, `poolCreatedAt` Map        | All pool instances and creation times lost    | Critical |
| SyncCoordinator    | `periodicJobs` Map                      | All scheduled syncs stop                      | High     |
| SyncCoordinator    | `pendingQueue` Array                    | Queued sync operations dropped                | Medium   |
| SyncStatusTracker  | `statuses` Map                          | Sync history, errors, last sync times lost    | Medium   |
| ActivityLog        | `events` Array (1000 events)            | Audit trail lost                              | Low      |
| WorkloadRegistry   | `workloads` Map                         | Can reload from YAML                          | Low      |

### Critical Gap: Docker Labels

The document previously stated Docker labels for `tenant-id` were "already implemented" - this is incorrect.

**Currently set on container creation (`manager.ts:202-207`):**
- `boilerhouse.managed` ✓
- `boilerhouse.container-id` ✓
- `boilerhouse.pool-id` ✓
- `boilerhouse.workload-id` ✓
- `boilerhouse.created-at` ✓

**NOT set (required for recovery):**
- `boilerhouse.tenant-id` - not updated when `assignToTenant()` is called
- `boilerhouse.claimed-at` - not set
- `boilerhouse.last-tenant-id` - needed for affinity recovery

The `syncFromRuntime()` method reads `tenant-id` back, but it's never written.

## Database Recommendation

### Why a Database?

The current approach of "Docker labels + YAML files" has fundamental limitations:

1. **Docker labels are immutable after creation** - You cannot update labels on a running container without recreating it. This means we can't track tenant assignments via labels.

2. **Multiple sources of truth** - YAML files for config, Docker for containers, in-memory for runtime state creates complexity and inconsistency risks.

3. **Affinity system needs persistence** - `affinityContainers` and `lastTenantId` are critical for the tenant experience but have no durable storage.

4. **Sync status is valuable** - Last sync times enable catch-up syncs; error history enables debugging.

### Recommendation: SQLite

SQLite is the right choice for Boilerhouse:

| Factor              | SQLite Advantage                                         |
|---------------------|----------------------------------------------------------|
| Deployment          | Single file, no separate process, embedded in app        |
| Performance         | Fast for our scale (hundreds of containers, not millions)|
| Durability          | ACID transactions, WAL mode for crash safety             |
| Complexity          | Zero ops burden, no connection pooling needed            |
| Bun support         | Native `bun:sqlite` with great performance               |

**When SQLite is NOT right:**
- Multi-node deployment (future) → would need PostgreSQL or shared storage
- High write throughput → not our workload

### Schema Design

```sql
-- Container state (source of truth for runtime state)
CREATE TABLE containers (
  container_id   TEXT PRIMARY KEY,
  pool_id        TEXT NOT NULL,
  workload_id    TEXT NOT NULL,
  tenant_id      TEXT,                    -- NULL if idle
  last_tenant_id TEXT,                    -- For affinity matching
  status         TEXT NOT NULL DEFAULT 'idle',
  socket_path    TEXT NOT NULL,
  state_dir      TEXT NOT NULL,
  secrets_dir    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  claimed_at     INTEGER,
  last_activity  INTEGER NOT NULL
);

CREATE INDEX idx_containers_pool ON containers(pool_id);
CREATE INDEX idx_containers_tenant ON containers(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_containers_last_tenant ON containers(last_tenant_id) WHERE last_tenant_id IS NOT NULL;

-- Affinity reservations (containers held for returning tenants)
CREATE TABLE affinity_reservations (
  tenant_id      TEXT PRIMARY KEY,
  container_id   TEXT NOT NULL REFERENCES containers(container_id),
  reserved_at    INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

-- Sync status tracking
CREATE TABLE sync_status (
  tenant_id      TEXT NOT NULL,
  sync_id        TEXT NOT NULL,
  last_sync_at   INTEGER,
  pending_count  INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'idle',
  PRIMARY KEY (tenant_id, sync_id)
);

-- Sync errors (recent history for debugging)
CREATE TABLE sync_errors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  sync_id        TEXT NOT NULL,
  timestamp      INTEGER NOT NULL,
  message        TEXT NOT NULL,
  mapping        TEXT
);

CREATE INDEX idx_sync_errors_tenant ON sync_errors(tenant_id, sync_id);

-- Activity log (optional, for audit trail)
CREATE TABLE activity_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type     TEXT NOT NULL,
  pool_id        TEXT,
  container_id   TEXT,
  tenant_id      TEXT,
  message        TEXT,
  timestamp      INTEGER NOT NULL
);

CREATE INDEX idx_activity_timestamp ON activity_log(timestamp DESC);
```

### Migration Path

1. **Add SQLite dependency** - Use `bun:sqlite` (built-in)
2. **Create database layer** - Simple repository pattern
3. **Dual-write during transition** - Write to both memory and SQLite
4. **Switch to SQLite as source of truth** - Read from SQLite on startup
5. **Remove in-memory maps** - Or keep as cache with SQLite backing

## Recovery Strategy

### Phase 1: Workload Registry (Already Implemented)

WorkloadSpecs load from YAML files at startup:
- **Location**: `config/workloads/*.yaml`
- **Status**: ✅ Implemented in `WorkloadRegistry.loadFromDirectory()`

Sync configuration is embedded in `WorkloadSpec.sync` - there is no separate SyncRegistry.

### Phase 2: Docker Label Updates (Required for Label-Based Recovery)

If NOT using SQLite, we need to update Docker labels when state changes.

**Problem:** Docker labels are immutable after container creation.

**Workaround:** Use container environment or a sidecar file:
```typescript
// Write state to a file inside the container's state directory
async function persistContainerState(container: PoolContainer): Promise<void> {
  const statePath = join(container.stateDir, '.boilerhouse-state.json')
  await writeFile(statePath, JSON.stringify({
    tenantId: container.tenantId,
    lastTenantId: container.lastTenantId,
    claimedAt: container.claimedAt,
    lastActivity: container.lastActivity,
  }))
}
```

**Recovery:** Read state files from each container's state directory on startup.

### Phase 3: SQLite-Based Recovery (Recommended)

With SQLite as the source of truth:

```typescript
// apps/api/lib/recovery.ts
export async function recoverFromDatabase(
  db: Database,
  runtime: ContainerRuntime,
  poolRegistry: PoolRegistry
): Promise<RecoveryResult> {
  // 1. Load containers from database
  const dbContainers = db.query('SELECT * FROM containers').all()

  // 2. Verify each container still exists in Docker
  const dockerContainers = await runtime.list({
    labels: { 'boilerhouse.managed': 'true' }
  })
  const dockerIds = new Set(dockerContainers.map(c => c.labels['boilerhouse.container-id']))

  // 3. Reconcile
  for (const dbContainer of dbContainers) {
    if (!dockerIds.has(dbContainer.container_id)) {
      // Container gone from Docker - mark as destroyed
      db.run('DELETE FROM containers WHERE container_id = ?', dbContainer.container_id)
      continue
    }

    // Restore to appropriate pool
    const pool = poolRegistry.get(dbContainer.pool_id)
    if (!pool) {
      // Pool no longer configured - destroy container
      await runtime.destroyContainer(dbContainer.container_id)
      db.run('DELETE FROM containers WHERE container_id = ?', dbContainer.container_id)
      continue
    }

    pool.restoreContainer(dbContainer)
  }

  // 4. Restore affinity reservations (with valid expiry)
  const now = Date.now()
  db.run('DELETE FROM affinity_reservations WHERE expires_at < ?', now)
  const reservations = db.query('SELECT * FROM affinity_reservations').all()
  for (const res of reservations) {
    const pool = poolRegistry.getByContainerId(res.container_id)
    pool?.restoreAffinityReservation(res.tenant_id, res.container_id, res.expires_at)
  }

  // 5. Recover sync jobs for claimed containers
  const claimedContainers = db.query(
    'SELECT * FROM containers WHERE tenant_id IS NOT NULL'
  ).all()
  // ... restart periodic syncs
}
```

### Phase 4: Sync Job Recovery

After container recovery, restart periodic sync jobs:

```typescript
export async function recoverSyncJobs(
  coordinator: SyncCoordinator,
  workloadRegistry: WorkloadRegistry,
  claimedContainers: PoolContainer[]
): Promise<void> {
  for (const container of claimedContainers) {
    const workload = workloadRegistry.get(container.workloadId)
    if (!workload?.sync) continue

    for (const syncConfig of workload.sync) {
      if (syncConfig.policy.intervalMs) {
        coordinator.startPeriodicSync(container.tenantId!, syncConfig, container)
      }
    }
  }
}
```

## Startup Sequence

```
1. Initialize database
   ├── Open SQLite database (create if not exists)
   ├── Run migrations if needed
   └── Enable WAL mode for crash safety

2. Load YAML registries
   ├── Load WorkloadSpecs from config/workloads/*.yaml
   └── Validate each spec against schema

3. Initialize pool registry
   ├── Create ContainerPool for each WorkloadSpec
   └── Set min/max container counts from config

4. Recover state from database
   ├── Load containers from database
   ├── Verify each container exists in Docker
   ├── Reconcile (remove stale DB entries, destroy orphaned containers)
   ├── Restore containers to appropriate pools
   └── Restore affinity reservations (filter expired)

5. Recover sync jobs
   ├── For each claimed container
   │   └── Start periodic sync jobs based on WorkloadSpec.sync
   └── Execute catch-up syncs if last_sync_at exceeds interval

6. Start file watchers (optional)
   └── Watch config/workloads/ for changes

7. Start API server
   └── Accept new requests
```

## Graceful Shutdown

To ensure clean shutdown:

1. Stop accepting new requests
2. Stop all periodic sync timers
3. Wait for in-progress syncs to complete (with timeout)
4. Execute final upload sync for all claimed containers
5. Update container labels with final state
6. Exit

```typescript
async function gracefulShutdown(
  coordinator: SyncCoordinator,
  pools: Map<PoolId, ContainerPool>
): Promise<void> {
  // Stop periodic syncs
  await coordinator.shutdown()

  // Final sync for all claimed containers
  for (const pool of pools.values()) {
    for (const { tenantId, container } of pool.getClaimedContainers()) {
      await coordinator.triggerSync(tenantId, container, 'upload')
    }
  }

  // Drain pools
  for (const pool of pools.values()) {
    await pool.drain()
  }
}
```

## Tasks

### Phase 1: Database Layer

- [ ] 1.1 Create `packages/db/` package with SQLite wrapper using `bun:sqlite`
- [ ] 1.2 Implement schema migrations system
- [ ] 1.3 Create initial schema (containers, affinity_reservations, sync_status, sync_errors)
- [ ] 1.4 Add repository classes: `ContainerRepository`, `AffinityRepository`, `SyncStatusRepository`
- [ ] 1.5 Add database initialization to API startup

### Phase 2: Container Persistence

- [ ] 2.1 Update `ContainerManager.createContainer()` to insert into database
- [ ] 2.2 Update `ContainerManager.assignToTenant()` to update database
- [ ] 2.3 Update `ContainerManager.releaseContainer()` to update database
- [ ] 2.4 Update `ContainerManager.destroyContainer()` to delete from database
- [ ] 2.5 Add `ContainerPool.restoreContainer()` method for recovery

### Phase 3: Affinity Persistence

- [ ] 3.1 Update `ContainerPool` to persist affinity reservations to database
- [ ] 3.2 Add `AffinityRepository.cleanupExpired()` for startup
- [ ] 3.3 Add `ContainerPool.restoreAffinityReservation()` method

### Phase 4: Sync Status Persistence

- [ ] 4.1 Update `SyncStatusTracker` to persist to database
- [ ] 4.2 Add `SyncStatusRepository.getLastSyncTime()` for catch-up logic
- [ ] 4.3 Implement catch-up sync (sync immediately if interval exceeded)

### Phase 5: Recovery & Startup

- [ ] 5.1 Implement `recoverFromDatabase()` function
- [ ] 5.2 Add Docker reconciliation (verify containers still exist)
- [ ] 5.3 Implement sync job recovery
- [ ] 5.4 Create startup orchestration that runs recovery sequence
- [ ] 5.5 Implement graceful shutdown handler
- [ ] 5.6 Final sync on shutdown for all claimed containers

### Phase 6: Testing

- [ ] 6.1 Unit tests for repository classes
- [ ] 6.2 Integration tests for recovery scenarios
- [ ] 6.3 Test crash recovery (kill process, restart, verify state)

## Failure Scenarios

### Database Failures

| Scenario                     | Detection                  | Recovery                                      |
|------------------------------|----------------------------|-----------------------------------------------|
| Database file missing        | Open fails                 | Create new database, lose state (cold start)  |
| Database corrupted           | SQLite integrity check     | Restore from backup or start fresh            |
| Crash during transaction     | WAL recovery               | Automatic rollback on next open               |
| Disk full                    | Write fails                | Return 500 error, operation not committed     |

### Docker/Database Inconsistency

| Scenario                     | Detection                  | Recovery                                      |
|------------------------------|----------------------------|-----------------------------------------------|
| Container in DB, not Docker  | Reconciliation on startup  | Delete from database                          |
| Container in Docker, not DB  | Reconciliation on startup  | Destroy container (or add to DB if labeled)   |
| Tenant claimed, Docker dead  | Health check failure       | Mark container unhealthy, reassign tenant     |

### YAML File Issues

| Scenario                     | Detection                  | Recovery                                      |
|------------------------------|----------------------------|-----------------------------------------------|
| Invalid YAML syntax          | Parse error on load        | Log error, skip file, continue startup        |
| Schema validation failure    | Validation error on load   | Log error, skip file, continue startup        |
| File deleted externally      | File watcher               | Remove workload, drain associated pool        |

### Recovery Commands

```bash
# Check database integrity
sqlite3 data/boilerhouse.db "PRAGMA integrity_check;"

# Backup database
cp data/boilerhouse.db data/boilerhouse.db.bak

# View current containers
sqlite3 data/boilerhouse.db "SELECT container_id, pool_id, tenant_id, status FROM containers;"

# Clear all state (fresh start)
rm data/boilerhouse.db
# Boilerhouse will create new database on startup
# Running containers will be destroyed during reconciliation
```

## Notes

### Sources of Truth

| Data                    | Source of Truth | Backup/Recovery                              |
|-------------------------|-----------------|----------------------------------------------|
| WorkloadSpecs           | YAML files      | Version control, reload from disk            |
| Container state         | SQLite          | Reconcile with Docker on startup             |
| Tenant assignments      | SQLite          | Lost if DB lost, containers reassigned       |
| Affinity reservations   | SQLite          | Expires naturally, non-critical              |
| Sync status/errors      | SQLite          | Nice-to-have, not critical                   |
| Actual containers       | Docker          | Source for reconciliation                    |

### Design Decisions

- **SQLite is the primary state store** for runtime data (containers, assignments, affinity)
- **YAML files are the config store** for workload definitions (version-controlled)
- **Docker is verified on startup** - database state is reconciled with Docker reality
- **WAL mode** ensures crash safety without explicit fsync on every write
- **Affinity has TTL** - reservations expire, so losing them is recoverable
- **Sync status is reconstructable** - worst case, we do a full sync on recovery

### Future Considerations

- **Multi-node**: SQLite works for single-node. Multi-node would need PostgreSQL or etcd.
- **Backup strategy**: Consider periodic SQLite backups to object storage.
- **Metrics**: Add Prometheus metrics for recovery events, reconciliation counts.
