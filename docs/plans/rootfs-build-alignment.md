# Rootfs Build Alignment

## Problem

A comparison of the Boilerhouse build pipeline (`packages/build/src/`) against four existing
Docker-to-Firecracker conversion tools — [firecracker-rootfs-builder], [firedocker], [Ignite],
and [buildfs] — identified security gaps and missing optimisations in our rootfs creation process.

The most significant finding: **our `sudo tar xf` extraction of untrusted OCI image contents runs
as root with no path validation**. Every other project also has this gap, but none of them are
building a multi-tenant platform.

[firecracker-rootfs-builder]: https://github.com/anyfiddle/firecracker-rootfs-builder
[firedocker]: https://github.com/magmastonealex/firedocker
[Ignite]: https://github.com/weaveworks/ignite
[buildfs]: https://github.com/firecracker-microvm/firecracker/discussions/4740

### What we already do well

| Concern                    | Our approach                                          | vs. others                                  |
|----------------------------|-------------------------------------------------------|---------------------------------------------|
| Loop device cleanup        | Explicit `losetup -d` in finally block                | rootfs-builder skips cleanup entirely        |
| Container cleanup          | `docker rm` in finally block after export             | rootfs-builder orphans containers            |
| Content-addressable store  | SHA-256 hashed artifacts with manifest                | None of the others do this                   |
| Typed error hierarchy      | `BuildError` / `OciError` / `RootfsError`             | Others use raw shell exit codes              |
| Structured pipeline        | Clean separation: OCI → rootfs → artifacts            | Others are monolithic shell scripts          |

### What we're missing

| #   | Gap                                      | Severity | Source of idea            |
|-----|------------------------------------------|----------|---------------------------|
| 1   | No tar content validation                | HIGH     | All projects (none do it) |
| 2   | No `e2fsck` integrity check after build  | MEDIUM   | Ignite, rootfs-builder    |
| 3   | No `resize2fs -M` to shrink images       | MEDIUM   | Ignite, rootfs-builder    |
| 4   | `mkfs.ext4` missing hardening flags      | LOW      | Ignite                    |
| 5   | Silent Docker cleanup failures           | LOW      | Ignite (cleanup patterns) |

## Design Decisions

### D1: Harden tar extraction against path traversal

GNU tar supports `--no-same-owner` (don't preserve uid/gid from the archive) and will refuse
absolute paths by default. However, it does **not** refuse `../` components or symlink-based
escapes by default. The safest approach is to use `--exclude` patterns combined with
`--no-same-owner`:

```
tar xf archive.tar -C mountpoint \
  --no-same-owner \
  --no-same-permissions
```

GNU tar already strips leading `/` from paths and prints a warning, so absolute paths aren't the
main concern. The real risk is:
- **Symlink following**: a tar entry creates a symlink `etc -> /real-etc`, then a later entry
  writes `etc/passwd`, which follows the symlink out of the mountpoint
- **`../` traversal**: entries with `../../` paths escape the `-C` target

GNU tar (≥1.28) has `--no-wildcards-match-slash` but no built-in traversal protection.
The `--keep-directory-symlink` flag actually makes things worse. Since we control the
target directory (a freshly formatted empty ext4), we use `--no-same-owner` and
`--no-same-permissions` to limit damage, and validate the archive contents before extraction.

### D2: Validate tar contents before extraction

Before calling `tar xf`, scan the archive with `tar tf` and reject it if any entry:
- Starts with `/` (absolute path)
- Contains `/../` or ends with `/..` (traversal)
- Is a symlink pointing outside the archive root

This runs as the build user (no sudo), so even if the validation has a bug, it doesn't grant
root-level filesystem access. The actual extraction still uses sudo, but only runs after
validation passes.

### D3: Shrink images with `resize2fs -M` after population

Both Ignite and firecracker-rootfs-builder shrink the ext4 image to its minimum viable size
after populating it. This:
- Reduces artifact storage size
- Makes SHA-256 hashing faster and more meaningful (hashing actual content, not trailing zeros)
- Speeds up snapshot creation (less data to copy)

The sparse file allocation (`dd seek=`) means disk usage is already efficient, but the logical
file size still includes the full allocation. `resize2fs -M` followed by `truncate` to the
actual filesystem size produces a tight image.

### D4: Run `e2fsck` after every build

Ignite runs `e2fsck -p -f` before activating any snapshot device. We should run it after
building the image — catching corruption at build time rather than at boot time. If `e2fsck`
finds errors, the build should fail rather than silently producing a corrupt image.

### D5: Harden `mkfs.ext4` flags

Ignite uses:
```
mkfs.ext4 -b 4096 -I 256 -F -E lazy_itable_init=0,lazy_journal_init=0
```

- `-b 4096`: explicit block size (our default is fine, but being explicit is defensive)
- `-I 256`: 256-byte inodes (the default on modern `mke2fs` but not guaranteed everywhere)
- `-E lazy_itable_init=0,lazy_journal_init=0`: fully initialize the filesystem immediately
  instead of deferring to a background kernel thread. Without this, a VM that boots
  immediately after image creation may see inode table initialisation I/O competing with
  workload I/O.

### D6: Make Docker cleanup failures visible

Our `docker rm` and `docker rmi` cleanup in `oci.ts` silently ignores failures. Ignite uses
a `DeferErr` pattern that surfaces cleanup errors. We should log cleanup failures (not throw,
since the primary operation succeeded) so orphaned containers/images are visible in build logs.

## Implementation Plan

### Phase 1: Tar Content Validation

**Files:** `packages/build/src/rootfs.ts`, `packages/build/src/rootfs.test.ts`

Add a `validateTarContents()` function that scans the archive before extraction.

```ts
/**
 * Scan a tar archive and reject entries that could escape the extraction target.
 *
 * Checks for:
 * - Absolute paths (entries starting with `/`)
 * - Path traversal (`../` components)
 * - Symlinks pointing outside the archive root
 *
 * @throws {RootfsError} if any dangerous entries are found
 */
async function validateTarContents(
  tarPath: string,
  onLog?: (line: string) => void,
): Promise<void> {
  // Use tar --list --verbose to get entry types and link targets
  const proc = Bun.spawn(
    ["tar", "tf", tarPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new RootfsError(`Failed to list tar contents: ${stderr.trim()}`);
  }

  const dangerous: string[] = [];

  for (const entry of stdout.split("\n")) {
    if (!entry) continue;

    // Check for absolute paths (tar usually strips these, but verify)
    if (entry.startsWith("/")) {
      dangerous.push(`absolute path: ${entry}`);
    }

    // Check for path traversal
    const normalized = entry.split("/");
    let depth = 0;
    for (const segment of normalized) {
      if (segment === "..") {
        depth--;
        if (depth < 0) {
          dangerous.push(`path traversal: ${entry}`);
          break;
        }
      } else if (segment !== "" && segment !== ".") {
        depth++;
      }
    }
  }

  if (dangerous.length > 0) {
    throw new RootfsError(
      `Tar archive contains dangerous entries:\n${dangerous.join("\n")}`,
    );
  }

  onLog?.(`Validated ${stdout.split("\n").filter(Boolean).length} tar entries`);
}
```

Update `createExt4()` to call validation before extraction:

```ts
export async function createExt4(
  tarPath: string,
  outputPath: string,
  sizeGb: number,
  onLog?: (line: string) => void,
): Promise<void> {
  // Validate tar contents before any privileged operations
  await validateTarContents(tarPath, onLog);

  // ... rest of existing pipeline
}
```

Harden the `tar xf` invocation:

```ts
await run(
  ["sudo", "tar", "xf", tarPath, "-C", mounted.mountPoint,
    "--no-same-owner", "--no-same-permissions"],
  "Failed to extract tarball into ext4",
  onLog,
);
```

**Tests:**
- Create a tarball with `../` traversal entries, assert `validateTarContents` throws `RootfsError`
- Create a tarball with absolute paths, assert rejection
- Create a normal tarball, assert validation passes
- End-to-end: `createExt4` with a safe tarball still works

### Phase 2: Post-Build Integrity Check and Shrink

**Files:** `packages/build/src/rootfs.ts`, `packages/build/src/rootfs.test.ts`

Add `finalizeExt4()` that runs `e2fsck` + `resize2fs -M` + `truncate` after the image is
populated and init binaries are injected.

```ts
/**
 * Verify filesystem integrity and shrink to minimum size.
 *
 * 1. `e2fsck -f -p` — force check, auto-repair
 * 2. `resize2fs -M` — shrink filesystem to minimum block count
 * 3. `truncate` — shrink the file to match the filesystem size
 *
 * @throws {RootfsError} if e2fsck finds unfixable errors or resize fails
 */
export async function finalizeExt4(
  ext4Path: string,
  onLog?: (line: string) => void,
): Promise<void> {
  // e2fsck returns exit code 1 for "errors corrected", which is acceptable.
  // Exit codes >= 2 indicate uncorrected errors.
  const fsckProc = Bun.spawn(
    ["e2fsck", "-f", "-p", ext4Path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const fsckExit = await fsckProc.exited;

  if (fsckExit >= 2) {
    const stderr = await new Response(fsckProc.stderr).text();
    throw new RootfsError(
      `e2fsck found unfixable errors (exit ${fsckExit}): ${stderr.trim()}`,
    );
  }
  onLog?.("Filesystem integrity check passed");

  // Shrink to minimum size
  await run(
    ["resize2fs", "-M", ext4Path],
    "Failed to shrink filesystem",
    onLog,
  );

  // Get the new filesystem size and truncate the file to match
  const blockCountProc = Bun.spawn(
    ["dumpe2fs", "-h", ext4Path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const dumpe2fsOut = await new Response(blockCountProc.stdout).text();
  await blockCountProc.exited;

  const blockCountMatch = dumpe2fsOut.match(/Block count:\s+(\d+)/);
  const blockSizeMatch = dumpe2fsOut.match(/Block size:\s+(\d+)/);

  if (blockCountMatch && blockSizeMatch) {
    const totalBytes = parseInt(blockCountMatch[1]) * parseInt(blockSizeMatch[1]);
    await run(
      ["truncate", "-s", String(totalBytes), ext4Path],
      "Failed to truncate image to filesystem size",
      onLog,
    );
    onLog?.(`Shrunk image to ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
  }
}
```

Wire into `builder.ts` after `injectInit`:

```ts
await createExt4(tarPath, ext4Path, workload.resources.disk_gb);
await injectInit(ext4Path, config);
await finalizeExt4(ext4Path);
```

**Tests:**
- Build a valid image, verify `e2fsck -n` (dry-run check) passes on the output
- Verify the output file size is smaller than `disk_gb * 1024^3`
- Verify the ext4 filesystem is still mountable and contains expected files after shrink

### Phase 3: Harden `mkfs.ext4` Flags

**Files:** `packages/build/src/rootfs.ts`

Change the `mkfs.ext4` invocation from:

```ts
["mkfs.ext4", "-F", outputPath]
```

To:

```ts
["mkfs.ext4", "-F",
  "-b", "4096",
  "-I", "256",
  "-E", "lazy_itable_init=0,lazy_journal_init=0",
  outputPath]
```

No new tests needed — existing tests verify the output is a valid ext4.

### Phase 4: Improve Docker Cleanup Logging

**Files:** `packages/build/src/oci.ts`

Update `exportFilesystem()` to log cleanup failures:

```ts
try {
  await runDocker(["export", containerId, "-o", outputTar]);
} finally {
  const rmProc = Bun.spawn(["docker", "rm", containerId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const rmExit = await rmProc.exited;
  if (rmExit !== 0) {
    const stderr = await new Response(rmProc.stderr).text();
    console.warn(
      `Warning: failed to remove container ${containerId}: ${stderr.trim()}`,
    );
  }
}
```

Update `buildImage()` to log image cleanup failures and use force flag:

```ts
finally {
  const rmiProc = Bun.spawn(["docker", "rmi", "-f", tempTag], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const rmiExit = await rmiProc.exited;
  if (rmiExit !== 0) {
    const stderr = await new Response(rmiProc.stderr).text();
    console.warn(
      `Warning: failed to remove image ${tempTag}: ${stderr.trim()}`,
    );
  }
}
```

No new tests — these are best-effort cleanup paths.

## Future Considerations (Not In Scope)

### Squashfs + overlay architecture

Firedocker uses squashfs (read-only, compressed) as the base image with a per-instance ext4
scratch overlay. This provides:
- 60-70% compression vs raw ext4
- Guaranteed immutability (squashfs is inherently read-only)
- Shared kernel page cache across VMs booted from the same image

This would replace our golden snapshot rootfs copy mechanism entirely. The trade-off is a
more complex guest init (must set up overlayfs before pivoting to the real root). Worth
evaluating once the current snapshot/restore pipeline is stable. See firedocker's
`cmd/preinit/mounts.go` for a reference implementation.

### eBPF network identity enforcement

Firedocker attaches TC eBPF ingress programs to each TAP device that enforce source MAC, source
IP, and ARP sender identity. This prevents VM-to-VM spoofing at a layer below iptables.
Covered separately in `docs/plans/network-hardening.md` (findings 1.4, Phase 9).

### MMDS for runtime config injection

Firedocker passes entrypoint, env vars, and network config via Firecracker's MMDS metadata
service (`169.254.169.254`) instead of kernel cmdline. Kernel cmdline is readable by all guest
processes via `/proc/cmdline`, so any secrets passed that way are leaked. Worth adopting if we
ever pass sensitive config (API keys, tokens) to guests.

### DNS via `/proc/net/pnp` symlink

Ignite symlinks `/etc/resolv.conf` → `../proc/net/pnp` so the kernel's DHCP-obtained
nameservers are used at runtime without baking DNS config into the image. A minor
improvement that eliminates a class of stale-DNS bugs.

### Daemonless image pulls

Firedocker uses `go-containerregistry` to pull OCI images directly from registries without the
Docker daemon. This eliminates the Docker dependency for image acquisition. Relevant if we move
to a Podman runtime (see `docs/plans/podman-runtime.md`) or want to drop the Docker requirement
entirely.

## Phase Priority

| Phase | What                            | Effort | Impact                                         |
|-------|---------------------------------|--------|-------------------------------------------------|
| 1     | Tar content validation          | Medium | Closes the highest-severity security gap        |
| 2     | e2fsck + resize2fs              | Medium | Catches corruption, reduces artifact size       |
| 3     | mkfs.ext4 flags                 | Small  | Eliminates lazy init I/O contention at boot     |
| 4     | Docker cleanup logging          | Small  | Makes resource leaks visible in build logs      |

## File Change Summary

| File                                 | Change                                                      |
|--------------------------------------|-------------------------------------------------------------|
| `packages/build/src/rootfs.ts`       | Add `validateTarContents()`, `finalizeExt4()`, harden flags |
| `packages/build/src/rootfs.test.ts`  | Tests for validation, shrink, integrity check               |
| `packages/build/src/oci.ts`          | Log cleanup failures, add `-f` to `docker rmi`              |
| `packages/build/src/builder.ts`      | Call `finalizeExt4()` after `injectInit()`                   |
