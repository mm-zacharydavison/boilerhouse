# Durability Plan

This document outlines how Boilerhouse can survive restarts and recover state for scheduled sync jobs, tenant assignments, and container pools.

## Current State

The following components hold in-memory state that would be lost on restart:

| Component         | State                          | Impact of Loss                            | Durability Strategy          |
|-------------------|--------------------------------|-------------------------------------------|------------------------------|
| SyncRegistry      | Registered SyncSpecs           | No sync operations possible               | YAML file-backed (Phase 3.1) |
| WorkloadRegistry  | Registered WorkloadSpecs       | No workloads available                    | YAML file-backed (Phase 3.1) |
| SyncStatusTracker | Sync status per tenant/spec    | Loss of error history, last sync times    | Optional SQLite (Phase 4)    |
| SyncCoordinator   | Periodic sync timers           | Scheduled syncs stop running              | Rebuild from registry        |
| ContainerManager  | Tenant → container assignments | Unknown which tenant owns which container | Docker labels                |

## Recovery Strategy

### Phase 1: YAML File-Backed Registries

SyncSpecs and WorkloadSpecs are stored as YAML files in config directories (see [Phase 3.1](./boilerhouse-architecture.md#phase-31-migrate-specs-to-yaml-configuration)). The registries are file-backed, meaning:

- **Startup**: Load all `*.yaml` files from config directories
- **API writes**: Mutations persist to YAML files immediately
- **Recovery**: Simply reload from config directories

**Config Directories:**
- `config/workloads/` - WorkloadSpec YAML files
- `config/sync/` - SyncSpec YAML files

**Implementation:**
```typescript
// Example: apps/api/lib/sync/registry.ts (file-backed)
export class SyncRegistry {
  constructor(private configDir: string) {}

  async loadFromDisk(): Promise<void> {
    const files = await glob('*.yaml', { cwd: this.configDir })
    for (const file of files) {
      const spec = await this.loadYamlFile(join(this.configDir, file))
      this.specs.set(spec.id, spec)
    }
  }

  async register(spec: SyncSpec): Promise<void> {
    // Validate
    this.validateSpec(spec)
    // Persist to disk first (durability)
    await this.writeYamlFile(spec)
    // Then update in-memory
    this.specs.set(spec.id, spec)
  }
}
```

#### YAML File Durability

To ensure YAML file writes survive crashes:

**Atomic Writes:**
```typescript
async function atomicWriteYaml(filePath: string, data: object): Promise<void> {
  const content = yaml.stringify(data)
  const tempPath = `${filePath}.tmp.${process.pid}`

  // Write to temp file
  await writeFile(tempPath, content, 'utf-8')

  // fsync to ensure data is on disk
  const fd = await open(tempPath, 'r')
  await fd.sync()
  await fd.close()

  // Atomic rename
  await rename(tempPath, filePath)

  // fsync parent directory (Linux requirement for rename durability)
  const dirFd = await open(dirname(filePath), 'r')
  await dirFd.sync()
  await dirFd.close()
}
```

**Backup on Modify:**
```typescript
async function writeWithBackup(filePath: string, data: object): Promise<void> {
  // Keep one backup
  if (await exists(filePath)) {
    await copyFile(filePath, `${filePath}.bak`)
  }
  await atomicWriteYaml(filePath, data)
}
```

**Validation Before Load:**
```typescript
async function loadYamlFile(filePath: string, schema: JSONSchema): Promise<SyncSpec> {
  const content = await readFile(filePath, 'utf-8')
  const data = yaml.parse(content)

  // Validate against schema
  const valid = ajv.validate(schema, data)
  if (!valid) {
    throw new ValidationError(`Invalid spec in ${filePath}: ${ajv.errorsText()}`)
  }

  return data as SyncSpec
}
```

### Phase 2: Docker State Recovery

Tenant assignments can be recovered by querying Docker for running containers with Boilerhouse labels.

**Container Labels (already implemented):**
- `boilerhouse.pool-id`: Pool the container belongs to
- `boilerhouse.tenant-id`: Tenant currently assigned (if claimed)
- `boilerhouse.claimed-at`: When the container was claimed

**Recovery Process:**
1. Query Docker for all containers with `boilerhouse.pool-id` label
2. Group containers by pool ID
3. For each container:
   - If `boilerhouse.tenant-id` is set → restore as claimed container
   - Otherwise → return to pool as available

```typescript
// Example: apps/api/lib/container/recovery.ts
export async function recoverContainerState(
  runtime: ContainerRuntime,
  pools: Map<PoolId, ContainerPool>
): Promise<RecoveryResult> {
  const containers = await runtime.list({
    labels: { 'boilerhouse.pool-id': '*' }
  })

  const recovered: RecoveredContainer[] = []

  for (const container of containers) {
    const poolId = container.labels['boilerhouse.pool-id']
    const tenantId = container.labels['boilerhouse.tenant-id']
    const pool = pools.get(poolId)

    if (!pool) {
      // Pool no longer configured - stop container
      await runtime.stop(container.id)
      continue
    }

    if (tenantId) {
      // Restore claimed container
      pool.restoreClaimed(container, tenantId)
      recovered.push({ container, tenantId, status: 'claimed' })
    } else {
      // Return to pool
      pool.restoreAvailable(container)
      recovered.push({ container, tenantId: null, status: 'available' })
    }
  }

  return { recovered }
}
```

### Phase 3: Sync Job Recovery

After recovering container assignments, restart periodic sync jobs for all claimed containers.

**Recovery Process:**
1. For each recovered claimed container:
   - Look up SyncSpecs for its pool
   - For specs with `policy.intervalMs`, restart periodic sync
   - Execute immediate sync if `lastSyncAt` exceeds interval

```typescript
// Example: apps/api/lib/sync/recovery.ts
export async function recoverSyncJobs(
  coordinator: SyncCoordinator,
  registry: SyncRegistry,
  claimedContainers: Array<{ tenantId: TenantId; container: PoolContainer }>
): Promise<void> {
  for (const { tenantId, container } of claimedContainers) {
    const specs = registry.getByPoolId(container.poolId)

    for (const spec of specs) {
      if (spec.policy.intervalMs) {
        // Restart periodic sync
        coordinator.startPeriodicSync(tenantId, spec, container)
      }
    }
  }
}
```

### Phase 4: Optional Persistence (Future)

For environments requiring stricter durability guarantees:

**SQLite for Status Persistence:**
```typescript
// Schema
CREATE TABLE sync_status (
  tenant_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  last_sync_at INTEGER,
  state TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sync_id)
);

CREATE TABLE sync_errors (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  message TEXT NOT NULL,
  mapping TEXT
);
```

This allows recovery of:
- Last sync times (to calculate catch-up syncs)
- Error history for debugging
- Sync state for status API

## Startup Sequence

```
1. Load YAML registries
   ├── Load WorkloadSpecs from config/workloads/*.yaml
   ├── Validate each spec against JSON Schema
   ├── Load SyncSpecs from config/sync/*.yaml
   └── Validate each spec against JSON Schema

2. Initialize pools
   ├── Create ContainerPool for each WorkloadSpec
   └── Set min/max container counts from config

3. Recover Docker state
   ├── Query Docker for boilerhouse containers
   ├── Restore claimed containers to pools
   └── Return unclaimed containers to pools

4. Recover sync jobs
   ├── For each claimed container
   │   └── Start periodic sync jobs from SyncRegistry
   └── Execute catch-up syncs if needed

5. Start file watchers (optional)
   ├── Watch config/workloads/ for changes
   └── Watch config/sync/ for changes

6. Start API server
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

### YAML File Registry Durability

- [ ] 4.1 Implement atomic YAML write utility (`atomicWriteYaml`)
- [ ] 4.2 Add fsync for directory after rename (Linux durability)
- [ ] 4.3 Implement backup-on-modify for YAML files
- [ ] 4.4 Add JSON Schema validation on YAML load
- [ ] 4.5 Handle corrupted YAML files gracefully (log error, skip, continue)
- [ ] 4.6 Implement file watcher for external config changes (optional)

### Container State Recovery

- [ ] 4.7 Add `restoreClaimed` and `restoreAvailable` methods to ContainerPool
- [ ] 4.8 Implement Docker state recovery in ContainerManager
- [ ] 4.9 Handle orphaned containers (pool no longer configured)

### Sync Job Recovery

- [ ] 4.10 Add `startPeriodicSync` as public method (currently private)
- [ ] 4.11 Implement sync job recovery function
- [ ] 4.12 Add catch-up sync logic (sync immediately if interval exceeded)

### Startup & Shutdown

- [ ] 4.13 Create startup orchestration that runs recovery sequence
- [ ] 4.14 Implement graceful shutdown handler
- [ ] 4.15 Final sync on shutdown for all claimed containers

### Optional Persistence

- [ ] 4.16 (Optional) Add SQLite persistence for sync status
- [ ] 4.17 Write integration tests for recovery scenarios

## Failure Scenarios

### YAML File Corruption

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Partial write (crash mid-write) | Temp file exists without main file | Delete orphaned `.tmp.*` files on startup |
| Invalid YAML syntax | Parse error on load | Log error, skip file, continue startup |
| Schema validation failure | Validation error on load | Log error, skip file, continue startup |
| File deleted externally | File watcher detects removal | Remove from in-memory registry |

### API Write Failures

| Scenario | Behavior |
|----------|----------|
| Disk full | Return 500 error, do not update in-memory state |
| Permission denied | Return 500 error, do not update in-memory state |
| Concurrent writes to same spec | Last write wins (file-level atomicity) |

### Recovery from Backup

If a YAML file is corrupted:
```bash
# Check backup exists
ls config/sync/my-spec.yaml.bak

# Restore from backup
cp config/sync/my-spec.yaml.bak config/sync/my-spec.yaml

# Restart or trigger reload
kill -HUP $BOILERHOUSE_PID
```

## Notes

- **YAML files are the source of truth** for WorkloadSpecs and SyncSpecs
- **Docker labels are the source of truth** for container assignments
- Periodic sync jobs are stateless - they can be recreated from container assignments + SyncRegistry
- Sync status (errors, last sync time) is nice-to-have but not critical for recovery
- Atomic writes with fsync ensure YAML changes survive power loss
- `.bak` files provide single-level rollback for manual recovery
- Config directories should be on durable storage (not tmpfs)
