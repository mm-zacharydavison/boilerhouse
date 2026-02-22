# Remove Dev Firecracker Runtime

## Problem

We maintain two code paths in `packages/runtime-firecracker` and `apps/api`:

1. **Dev mode** — Firecracker spawned directly, host-level TAP devices via `TapManager`, no chroot, no isolation
2. **Jailer mode** — Firecracker spawned via `jailer`, per-VM network namespaces via `NetnsManagerImpl`, chroot jails via `JailPreparer`

The branching (`if (this.isJailerMode) ... else ...`) is spread across create, destroy, snapshot, restore, getEndpoint, recovery, and server startup. Both paths must be kept in sync whenever behaviour changes. Since the setup script already supports `--profile dev` and configures jailer for the local user, there is no reason to keep the simpler but less capable dev path.

## Goal

Remove the dev-mode code path entirely. Jailer mode becomes the only mode. The `FirecrackerRuntime` no longer accepts a `TapManager` and no longer branches on `isJailerMode`.

## Pre-requisite

Dev machines must run the setup script before using the Firecracker runtime:

```sh
./scripts/setup-firecracker.sh --profile dev
```

This is already documented and already sets up everything jailer mode needs (sudoers, sysctl, /srv/jailer, subuid range). No changes to the script needed.

## Changes

### Phase 1: Runtime package (`packages/runtime-firecracker`)

#### 1a. `types.ts` — Remove dev-mode types from config

| Change                                               | Detail                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Remove `TapDevice` interface                         | No longer needed (netns handles TAP internally)                         |
| Remove `TapManager` interface                        | Consumer-provided TAP manager is no longer used                         |
| Remove `tapManager?` from `FirecrackerConfig`        | Jailer is now required                                                  |
| Make `jailer` **required** in `FirecrackerConfig`    | Was optional, becomes mandatory (rename field to just `jailer`)         |
| Remove `"dev mode"` / `"production mode"` JSDoc refs | Update docs to reflect single mode                                      |

#### 1b. `runtime.ts` — Collapse to single code path

| Change                                                                   | Detail                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Remove `isJailerMode` field and constructor guard                        | Constructor only needs to check that `config.jailer` exists                               |
| Delete `createDirect()` method (~80 lines)                               | Was the dev-mode create path                                                              |
| Delete `snapshotDirect()` method (~65 lines)                             | Was the dev-mode snapshot path                                                            |
| Delete `restoreDirect()` method (~80 lines)                              | Was the dev-mode restore path — also used netns for restore, which jailer mode also does  |
| Delete `createRootfsSymlink()` / `removeRootfsSymlink()` helper methods  | Only used by `restoreDirect`                                                              |
| Rename `createJailed` → `createInstance` (or inline into `create`)       | No longer needs the "jailed" qualifier                                                    |
| Rename `snapshotJailed` → `snapshotInstance` (or inline into `snapshot`) | Same                                                                                      |
| Rename `restoreJailed` → `restoreInstance` (or inline into `restore`)    | Same                                                                                      |
| Simplify `destroy()` — remove the dev-mode branch                        | Only the jailer cleanup path remains (kill via PID, destroy netns, cleanup jail)           |
| Simplify `getEndpoint()` — remove `tapDevice` fallback                   | Always use `netnsHandle.guestIp`                                                          |
| Simplify `available()` — always check for jailer binary                  | Remove the `if (this.isJailerMode)` branch                                                |
| Remove `tapDevice?` from `ManagedInstance`                               | Only `netnsHandle` and `jailPaths` remain                                                 |
| Remove the standalone `deriveGuestIp()` helper at module top             | Was only used by dev-mode `createDirect` and `getEndpoint` fallback                       |

#### 1c. `process.ts` — No changes needed

Both `spawnFirecracker` and `spawnJailer` stay. `spawnFirecracker` is still used by `restoreDirect` in the current code, but after this change it is no longer called at all. However, `spawnFirecracker` is also used when the jailer `restoreJailed` path spawns Firecracker inside a netns (see `restoreDirect` which is actually used in dev-mode restore only). Let me re-check:

- `createJailed` → calls `spawnJailer` ✓
- `restoreJailed` → calls `spawnJailer` ✓
- `createDirect` → calls `spawnFirecracker` (being deleted)
- `restoreDirect` → calls `spawnFirecracker` with `netnsName` (being deleted)

So after removing dev mode: **`spawnFirecracker` is no longer called by the runtime**. However, keep it exported for now — it's a useful primitive and tests may reference it. If we want to clean further, we can remove it later.

Actually — **delete `spawnFirecracker`** and `SpawnOptions` / `FirecrackerProcess` interface. They are only used by the dev code path. The `consolePath` field on `FirecrackerProcess` was exposed via `meta` on instance handles — jailer mode doesn't currently expose console output path, which is acceptable (console logs are less useful in jailed mode; the firecracker log is in the jail directory).

Wait — checking `createDirect`: it returns `meta.consolePath`. `createJailed` does not. This means after removal, no `consolePath` is returned. This is a minor feature regression but acceptable since the console is inside the chroot and accessible via `jailPaths.chrootRoot`.

**Decision**: Keep `spawnFirecracker` and its types but stop exporting from `index.ts`. This way the file isn't deleted unnecessarily. Actually simpler: just leave it alone. Dead code can be cleaned later.

**Revised decision**: Delete `spawnFirecracker`, `SpawnOptions`, `FirecrackerProcess` interface. They have no callers after this change.

#### 1d. `index.ts` — Update exports

| Change                                      | Detail                                 |
| ------------------------------------------- | -------------------------------------- |
| Remove `TapDevice` from type exports        | Type no longer exists                  |
| Remove `TapManager` from type exports       | Type no longer exists                  |

#### 1e. `errors.ts` — Check for dead errors

`FirecrackerProcessError` was thrown by `spawnFirecracker`. If we delete that function, check if the error class is still used elsewhere. If not, remove it.

### Phase 2: API server (`apps/api`)

#### 2a. `network/tap.ts` — Delete file

The entire `TapManager` class and `TapDevice` type live here. No longer used.

#### 2b. `network/tap.test.ts`, `network/tap.integration.test.ts` — Delete files

Tests for the deleted `TapManager`.

#### 2c. `network/iptables.ts` — Check usage

`IptablesManager` references `TapDevice` from `./tap`. After deleting `tap.ts`, check if `IptablesManager` is used anywhere. If it's only used by dev-mode networking, delete it and its tests too.

If it's still needed (e.g. for future network hardening), update its `TapDevice` import to use a local inline type or import from the runtime package.

**Looking at the code**: `IptablesManager.setupForInstance` takes a `TapDevice` param and generates iptables rules for host-level TAP devices. This is a dev-mode-only concept — in jailer mode, iptables rules are managed inside `NetnsManagerImpl`. **Delete `iptables.ts` and its tests.**

#### 2d. `server.ts` — Simplify startup

| Change                                                      | Detail                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Remove `TapManager` import                                  | Deleted                                                 |
| Remove `useJailer` conditional                              | Always jailer mode                                      |
| Make `JAILER_BIN` required (error if missing)               | Clear error message: "JAILER_BIN env var is required"   |
| Remove `tapManager` from `runtimeConfig`                    | Field no longer exists                                  |
| Always construct `jailerConfig` and set `runtimeConfig.jailer` | No branching                                         |
| Simplify recovery options — remove TAP cleanup branch       | Only netns + jail cleanup remains                       |

#### 2e. `recovery.ts` — Remove TAP recovery

| Change                                          | Detail                               |
| ------------------------------------------------ | ------------------------------------- |
| Remove `TapLister` / `TapDestroyer` types        | No longer needed                      |
| Remove `listTaps` / `destroyTap` from `RecoveryOptions` | TAP cleanup goes away          |
| Remove `orphanedTapsCleaned` from `RecoveryReport` | Simplify report                    |
| Remove `TapManager` import                       | No longer used                        |
| Remove TAP cleanup logic (step 4)                | Only netns + jail cleanup remains     |

#### 2f. `e2e/e2e-helpers.ts` — Update Firecracker E2E setup

The `startE2EServer` function creates a `TapManager` for firecracker runtime E2E tests. This needs to switch to jailer mode:

| Change                                                      | Detail                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| Remove `TapManager` import and usage                        | No longer exists                                                |
| Configure `jailer` in `FirecrackerConfig` for E2E           | Use env vars: `JAILER_BIN`, `JAILER_CHROOT_BASE`, etc.         |
| Update `runtimeCleanup` to clean netns + jails              | Was only cleaning temp dirs; now also cleans namespaces + jails |

#### 2g. `e2e/runtime-matrix.ts` — Update Firecracker entry

| Change                                                            | Detail                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Set `concurrentRestore: true` for firecracker                     | Jailer mode supports it (per-instance netns)               |
| Update `verifyCleanup` to check for orphaned netns/jails          | Currently a no-op for firecracker                          |

### Phase 3: Tests

#### 3a. Runtime unit/integration tests

`packages/runtime-firecracker/src/runtime.integration.test.ts` — update to only test jailer mode. Remove any dev-mode-specific test paths.

#### 3b. Recovery tests

Any tests in `apps/api` that exercise TAP recovery need to be removed or rewritten for netns/jail recovery.

#### 3c. Network tests

Delete `apps/api/src/network/tap.test.ts` and `tap.integration.test.ts`. Check if `iptables.test.ts` and `iptables.integration.test.ts` should also be deleted (see 2c above).

### Phase 4: Documentation / Plans

- Update `docs/plans/firecracker-jailer.md` — mark as complete, note that dev mode was removed
- Update `docs/plans/network-hardening.md` if it references `TapManager`

## Files Summary

### Delete

| File                                                  | Reason                             |
| ----------------------------------------------------- | ---------------------------------- |
| `apps/api/src/network/tap.ts`                         | Dev-mode TAP manager               |
| `apps/api/src/network/tap.test.ts`                    | Tests for deleted code             |
| `apps/api/src/network/tap.integration.test.ts`        | Tests for deleted code             |
| `apps/api/src/network/iptables.ts`                    | Dev-mode iptables (host-level TAP) |
| `apps/api/src/network/iptables.test.ts`               | Tests for deleted code             |
| `apps/api/src/network/iptables.integration.test.ts`   | Tests for deleted code             |

### Major edits

| File                                                         | Summary                                     |
| ------------------------------------------------------------ | ------------------------------------------- |
| `packages/runtime-firecracker/src/types.ts`                  | Remove TapDevice, TapManager, make jailer required |
| `packages/runtime-firecracker/src/runtime.ts`                | Delete ~225 lines of dev-mode methods, simplify all branching |
| `packages/runtime-firecracker/src/process.ts`                | Delete `spawnFirecracker`, `SpawnOptions`, `FirecrackerProcess` (~50 lines) |
| `packages/runtime-firecracker/src/index.ts`                  | Remove TapDevice/TapManager exports         |
| `apps/api/src/server.ts`                                     | Remove TapManager, make JAILER_BIN required, simplify recovery |
| `apps/api/src/recovery.ts`                                   | Remove TAP recovery types and logic          |
| `apps/api/src/e2e/e2e-helpers.ts`                            | Switch from TapManager to jailer config      |
| `apps/api/src/e2e/runtime-matrix.ts`                         | Update firecracker capabilities              |

## Risk

- **Low**: Jailer mode is already the production path and well-tested.
- **E2E tests on CI**: If CI doesn't have sudoers/jailer set up, firecracker E2E tests will fail. Ensure CI runs `setup-firecracker.sh --profile dev` or skip firecracker E2E tests on CI (they're already gated by `detectRuntimes()`).
- **Console log path**: Dev mode exposed `consolePath` in instance handle metadata. Jailer mode doesn't. If anything reads this, it will get `undefined`. Acceptable — the console is inside the chroot at `{chrootRoot}/dev/console` or via the firecracker log.

## Order of operations

1. Phase 1 (runtime package) — make the types and runtime jailer-only
2. Phase 2 (API server) — update all consumers
3. Phase 3 (tests) — delete/update tests
4. Phase 4 (docs) — update plan docs
5. Run `bun test` across the whole project, fix any breakage
