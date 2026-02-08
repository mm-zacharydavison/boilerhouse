# Volume Seed Files

## Problem

Containers need default files present when a tenant first gets one. For example, OpenClaw needs an `openclaw.json` config and default workspace files. After wipe-on-acquire, the state directory is empty — there's no way to provide defaults.

The sync module downloads tenant-specific state, but new tenants with no remote state get an empty directory. We need a mechanism to populate volumes with factory defaults.

## Design

Add a `seed` field to volume configs pointing to a directory of default files. The seed directory lives alongside workload YAML files in the same mount (`./workloads:/etc/boilerhouse/workloads:ro`).

Seed is integrated into the claim flow, gated by a cheap check: **only seed if the volume directory is empty after sync**. One `readdir` call — microseconds — and completely skipped for returning tenants.

- **Returning tenant (affinity)**: no wipe, data intact → volume not empty → seed skipped entirely.
- **Returning tenant (different container)**: wipe → sync downloads their data → volume not empty → seed skipped.
- **New tenant**: wipe → sync downloads nothing (remote empty) → volume empty → seed copies defaults. On release, sync uploads everything. Next claim, sync provides it all.
- **No sync configured**: wipe → volume empty → seed copies defaults every time.

## Directory Structure

```
workloads/                          # mounted at /etc/boilerhouse/workloads
  openclaw.yaml
  openclaw-seed/                    # seed data for openclaw's state volume
    openclaw.json
    workspace/
      SOUL.md
  example.yaml                      # no seed — works exactly as today
```

## Workload YAML

```yaml
# openclaw.yaml
volumes:
  state:
    target: /home/node/.openclaw
    seed: ./openclaw-seed           # relative to this YAML file
```

The `seed` field is optional on any volume config (state, secrets, comm, custom). Path is resolved to absolute at load time relative to the YAML file's directory.

## Lifecycle

```
Claim flow (in claim.ts):
  acquire (wipe if new tenant)  →  sync download  →  seed if empty  →  restart  →  healthy

New tenant (no remote data):
  wipe  →  sync downloads nothing  →  volume empty → seed copies defaults  →  restart

Returning tenant (has remote data):
  wipe  →  sync downloads data  →  volume not empty → seed skipped  →  restart

Returning tenant (affinity, same container):
  no wipe  →  sync  →  volume not empty → seed skipped  →  restart

No sync configured:
  wipe  →  volume empty → seed copies defaults  →  restart
```

On release, sync uploads everything (including seed-originated files). Next claim, sync provides them — seed is skipped.

## Implementation

### Schema (`packages/core/src/schemas/workload.ts`)

Add `seed` to `volumeConfigSchema`:

```ts
export const volumeConfigSchema = z.object({
  target: z.string().describe('Path inside the container where the volume is mounted'),
  read_only: z.boolean().optional().default(false).describe('Mount as read-only'),
  seed: z.string().optional().describe(
    'Path to a directory of seed files to merge into this volume during claim. '
    + 'Only copies files that do not already exist. Resolved relative to the workload YAML file.'
  ),
})
```

### Loader (`apps/api/lib/workload/loader.ts`)

After parsing, resolve relative seed paths to absolute using `path.resolve(dirname(filePath), seed)`. Validate directory exists at load time — fail fast on bad paths.

```ts
function resolveSeedPaths(spec: WorkloadSpec, yamlDir: string): WorkloadSpec
```

Walk `volumes.state`, `volumes.secrets`, `volumes.comm`, `volumes.custom` — resolve any `.seed` field.

### Manager (`apps/api/lib/container/manager.ts`)

New method:

```ts
async applySeed(containerId: ContainerId, workload: WorkloadSpec): Promise<void>
```

- For each volume with a `seed` path:
  1. Check if the volume's host directory is empty (`readdir`, check length === 0)
  2. If not empty, skip — sync already provided the tenant's data
  3. If empty, copy seed dir contents into the host directory using `fs.cp(src, dest, { recursive: true })`
  4. If `workload.user` specifies a UID, `chown` copied files

The empty-dir check makes this essentially free for returning tenants (one syscall, no I/O).

### Claim (`apps/api/lib/container/claim.ts`)

Call `applySeed` after sync, before restart:

```ts
// Sync downloads tenant data (if any)
if (workload.sync) { ... }

// Seed: fill defaults into empty volumes (skipped if sync provided data)
await containerManager.applySeed(container.containerId, workload)

// Restart container with synced + seeded data
await containerManager.restartContainer(container.containerId, 2)
```

### Pool (`apps/api/lib/container/pool.ts`)

No changes needed. Seed runs during claim, not during pool operations.

## Edge Cases

- **No seed configured**: Optional field. Behavior is identical to today. Zero impact on existing workloads.
- **Empty seed directory**: No-op — nothing to copy.
- **Seed on read-only volume** (e.g., secrets): Works. Files are copied to host dir before container mounts it read-only.
- **Seed + sync**: Seed only runs if volume is empty after sync (new tenant). Returning tenants: seed is skipped entirely (one `readdir` check).
- **File ownership**: Newly copied files are chowned to match `workload.user` UID.
- **Seed dir missing at load time**: `WorkloadValidationError` thrown in loader. Fail fast.

## Future: Workload Migration

Current design: seed only runs when the volume is empty (new tenant). If the workload definition changes after tenants already exist (e.g., new seed files added, defaults updated), existing tenants won't pick up the changes — their remote data already has content, so seed is skipped.

Example scenario:
1. v1 seed has `openclaw.json` with defaults
2. Tenant claims, gets seeded, mutates config, releases (synced to remote)
3. v2 seed adds `workspace/new-config.yaml` and updates `openclaw.json`
4. Tenant re-claims — sync downloads their v1 data — volume not empty — seed skipped
5. Tenant never sees the new file or updated defaults

Possible approaches for later:
- **Seed versioning**: Track a `seed_version` per tenant in the DB or sync metadata. If workload's seed version is newer, re-apply seed as a merge (add new files, don't overwrite existing).
- **Migration scripts**: Add a `migrations/` directory alongside seed. Numbered scripts (e.g., `001-add-new-config.sh`) run once per tenant when the workload version advances.
- **Diff-based**: Compute delta between old and new seed, apply additions to tenant's state.

Not implementing now — the "empty volume" check is correct for the initial version. Migration can layer on top later without changing the seed mechanism.

## Tests

### Unit tests (`apps/api/lib/container/container.unit.test.ts`)

Uses mock runtime + temp dirs. No Docker required.

**applySeed basics:**
- Seed files are copied to state dir when volume is empty
- Seed is skipped when volume already has files
- Seed files are chowned to workload user UID
- No-op when workload has no seed configured
- Nested seed directories are copied recursively

**Claim flow with seed:**
- New tenant (empty state dir after wipe) → seed files present after claim
- Returning tenant (affinity, data intact) → seed skipped, original files untouched
- Different tenant with mock sync that writes files → seed skipped (volume not empty)

### E2E tests (`apps/api/test/claiming.e2e.test.ts`)

Uses test harness with workload that has seed configured.

**New tenant gets seed defaults:**
- Create workload with seed dir containing test files
- Claim container for new tenant
- Verify seed files exist on host state dir
- Verify seed files are readable inside container (via exec)

**Returning tenant preserves mutations:**
- Claim → seed applied → tenant modifies a seed file → release
- Re-claim (affinity) → verify modified file persists, seed did not overwrite

**Seed + wipe isolation:**
- Tenant A claims → modifies seed file → releases
- Tenant B claims same container → wipe → seed re-applied with original defaults
- Verify tenant A's modifications are gone, seed defaults restored

**No seed configured:**
- Workload without seed field → claim → state dir is empty → no errors

### Loader tests (`apps/api/lib/workload/loader.test.ts`)

**Seed path resolution:**
- Relative seed path resolved against YAML file directory
- Absolute seed path kept as-is
- Missing seed directory throws `WorkloadValidationError` at load time
- Workload without seed field loads normally
