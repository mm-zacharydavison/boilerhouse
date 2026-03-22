# Parallel Golden Restores

## Problem

CRIU cannot restore the same checkpoint archive concurrently. Today,
`TenantManager.serializedRestore()` enforces a per-snapshot mutex so
that all restores from the same golden snapshot are queued one-at-a-time.

For workloads with burst claim patterns (e.g. 10 tenants claiming the
same workload simultaneously), this serialization is the dominant
latency bottleneck — the Nth tenant waits for N-1 restores to complete
sequentially.

---

## Prior Art

How other systems solve parallel restore from a golden snapshot:

### Firecracker (AWS Lambda, Fly.io, CodeSandbox)

[github.com/firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker)

Firecracker `mmap`s the snapshot memory file with `MAP_PRIVATE`, giving
each restored microVM its own copy-on-write view of the same file.
Concurrent restores share clean pages via the kernel page cache and
only allocate memory for pages that diverge. This is the gold standard
for parallel snapshot restore — zero copy overhead, kernel-managed CoW.

AWS Lambda's SnapStart extends this with **userfaultfd (UFFD)**: a
userspace page-fault handler loads pages on-demand from a remote
store, so the snapshot doesn't even need to be fully local. CodeSandbox
uses the same UFFD approach to clone running VMs in ~2 seconds
([blog post](https://codesandbox.io/blog/how-we-clone-a-running-vm-in-2-seconds)).

Firecracker operates at the VM level, not container/CRIU level, so
`MAP_PRIVATE` mmap is natural. CRIU restores processes, not VMs, and
doesn't expose the same mmap-based restore path.

**References:**
- [Snapshot support docs](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [Page fault handling docs](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/handling-page-faults-on-snapshot-resume.md)
- [On-demand Container Loading in AWS Lambda (USENIX ATC'23)](https://www.usenix.org/system/files/atc23-brooker.pdf)
- [Restoring Uniqueness in MicroVM Snapshots](https://arxiv.org/abs/2102.12892)

### LXD / Incus (btrfs/ZFS CoW clones)

[linuxcontainers.org/incus/docs/main/reference/storage_drivers](https://linuxcontainers.org/incus/docs/main/reference/storage_drivers/)

Incus snapshots a golden container's filesystem using ZFS snapshots or
btrfs subvolumes. New containers are created via `zfs clone` or
`btrfs subvolume snapshot` — instant, zero-copy, fully parallel. Each
clone shares base blocks and only writes deltas.

**This is the closest analogue to our proposed Option A.** The
difference is that Incus clones the *filesystem*, not a CRIU checkpoint
archive. Our approach applies the same CoW-clone idea to the checkpoint
tar archive itself.

### Kata Containers (VM templating)

[github.com/kata-containers/kata-containers](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/what-is-vm-templating-and-how-do-I-use-it.md)

Kata creates a "template VM" and maps its kernel/initramfs/agent memory
as **readonly shared mappings**. Each new VM clone gets a writeable
overlay. Parallel clones share the read-only base, similar to
Firecracker's MAP_PRIVATE approach but at the hypervisor level.

### gVisor (Modal)

[gvisor.dev/docs/user_guide/checkpoint_restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/)

gVisor checkpoints its entire userspace kernel state to a file. Each
restore creates a completely independent sandbox — no CRIU involved, so
there's no shared-archive contention. Modal uses this for sub-second
container startup, including GPU memory snapshots via NVIDIA's CUDA C/R.

**Reference:** [Modal memory snapshots blog](https://modal.com/blog/mem-snapshots)

### Podman + CRIU

[podman.io/docs/checkpoint](https://podman.io/docs/checkpoint)

Podman supports `podman container restore <checkpoint-1> <checkpoint-2>`
— restoring multiple *different* checkpoints in parallel. Each restore
creates an independent container. Checkpoints can be stored as OCI
images and pushed to registries.

However, restoring the *same* checkpoint archive concurrently from the
same path is not supported — which is exactly our bottleneck.

### CRaC (Coordinated Restore at Checkpoint)

[crac.org](https://crac.org/) /
[github.com/crac](https://github.com/crac)

CRaC checkpoints a warmed JVM using CRIU under the hood. Each restore
creates an independent JVM process from the checkpoint files. The
snapshot files are read-only inputs — CRaC doesn't address concurrent
restore from the same archive specifically, but since each JVM is
independent, multiple restores can run if the files aren't locked.
Restore latency: ~40ms vs seconds for cold JVM start.

### Academic Work

- **REAP** (ASPLOS '22) — Records the memory working set during first
  invocation, prefetches only those pages on restore via userfaultfd.
  61–96% memory reduction.
  ([PDF](https://marioskogias.github.io/docs/reap.pdf))
- **FaaSnap** (EuroSys '22) — 3.5× faster than REAP via optimized
  snapshot loading with Firecracker.
  ([PDF](https://www.sysnet.ucsd.edu/~voelker/pubs/faasnap-eurosys22.pdf))
- **Spice** (2025) — Shows both CRIU and VM approaches bottleneck on
  OS metadata restoration; proposes dedicated kernel interfaces.
  ([arXiv](https://arxiv.org/html/2509.14292v1))

### Summary of Patterns

| Pattern | Used By | Mechanism |
|---|---|---|
| MAP_PRIVATE mmap (CoW) | Firecracker, Lambda | Kernel CoW on memory-mapped snapshot; each VM gets private dirty pages |
| Userfaultfd (UFFD) | Firecracker, CodeSandbox, REAP | Userspace page-fault handler loads pages on-demand |
| ZFS/btrfs clone | LXD/Incus | Filesystem-level CoW; instant zero-copy clones |
| VM template (readonly shared) | Kata Containers | Shared readonly memory + writeable overlay per clone |
| Independent restore | CRIU, Podman, CRaC, gVisor | Each restore reads checkpoint and creates independent process tree |

### Takeaway for Boilerhouse

The MAP_PRIVATE/UFFD approaches (Firecracker, Lambda) are the most
elegant but require VM-level control we don't have — we use CRIU via
Podman, which operates on process trees not memory-mapped VM images.

The closest applicable pattern is **LXD/Incus's filesystem CoW clone**:
copy the snapshot archive using btrfs/reflink before each restore, so
each CRIU invocation sees its own file. This is what Option A proposes.

---

## Options Considered

### Option A: Copy-Before-Restore (recommended)

Copy the golden snapshot archive before each restore. Each concurrent
restore gets its own copy, so there is no contention on the original.

Use the fastest copy mechanism available on the volume:
btrfs subvolume snapshot > cp --reflink > full cp.

| | |
|---|---|
| **Pros** | Simple, restores are fully parallel, no idle resource cost, minimal code change (~5 files), works on any filesystem with graceful degradation |
| **Cons** | On non-CoW filesystems (ext4), falls back to full copy which adds I/O latency per restore. Requires btrfs/XFS-reflink on the snapshot volume for near-instant copies. |
| **Complexity** | Low |
| **Latency improvement** | Restores run in parallel; per-restore latency unchanged. On CoW: near-zero overhead. On ext4 fallback: adds copy time (~seconds for large archives). |

### Option B: Pre-Warmed Instance Pool

Maintain a pool of N already-restored instances per workload. Claims
grab a warm instance instead of restoring on-demand. A background
replenisher restores new instances into the pool (serialized, off the
hot path).

| | |
|---|---|
| **Pros** | Zero restore latency on claim — instances are already running. Best possible claim speed. |
| **Cons** | Idle resource consumption (CPU, memory, disk) for pre-warmed instances. Requires pool sizing logic (min/max/scale-up triggers). More complex lifecycle — pool instances need health checks, eviction, and replenishment. Cold-start latency shifts to pool replenishment (which is still serialized). |
| **Complexity** | High — new `InstancePool` component, background replenisher, pool sizing config, health monitoring. |
| **Latency improvement** | Claims are instant. But pool replenishment still serialized unless combined with Option A. |

### Option C: Snapshot Replica Fan-Out

Pre-copy the golden archive to N replicas on disk at golden-creation
time (`golden-<id>-replica-0.tar.gz`, ..., `golden-<id>-replica-N.tar.gz`).
Concurrent restores each pick a different replica, giving N-way
parallelism.

| | |
|---|---|
| **Pros** | No per-restore copy overhead — replicas are created ahead of time. Simple concurrency model (round-robin or least-recently-used). |
| **Cons** | Disk space scales linearly with replica count (N × archive size). Must choose N upfront — under-provisioned = still queuing, over-provisioned = wasted disk. Replicas must be re-created when golden is updated. |
| **Complexity** | Medium — replica management in `SnapshotManager`, cleanup on golden rotation. |
| **Latency improvement** | Up to N-way parallel. Still has restore latency per claim. |

### Option D: Hardlink per Restore

Use `ln` to hardlink the archive to a unique path before each restore.
Instant, no extra disk (same inode).

| | |
|---|---|
| **Pros** | Instant, zero disk overhead, works on any filesystem. |
| **Cons** | **Does not solve the problem.** Hardlinks share the same underlying inode and data blocks — CRIU still contends on the same file. Only works if CRIU's issue is with the *path* rather than the *file content*, which is not guaranteed and not documented. Would need testing to validate. |
| **Complexity** | Trivial if it works. |
| **Latency improvement** | Unknown — depends on whether CRIU's concurrency limitation is path-based or inode-based. |

### Recommendation

**Option A (Copy-Before-Restore)** is the best balance of simplicity,
correctness, and performance. It directly removes the mutex with
minimal architectural change. On a btrfs or reflink-capable volume the
copy is near-instant and free; on ext4 it degrades gracefully to a
full copy (still parallel, just slower per-restore).

Option B (pool) could be layered on top later if claim latency (not
just parallelism) becomes the bottleneck — and it would benefit from
Option A for its own background replenishment.

Option D (hardlink) is worth a quick spike to test whether CRIU's
limitation is path-based. If it works, it's strictly better than
Option A since it has zero overhead on any filesystem. But it's
unproven, so Option A is the safe bet.

---

## Approach (Option A)

**Always copy the golden snapshot archive before restoring from it.**
Each concurrent restore gets its own copy, so the CRIU constraint
(no concurrent restores from the same archive) no longer applies.

The copy step uses the fastest available mechanism:

1. **btrfs subvolume snapshot** — near-instant, zero additional disk
   (CoW). Preferred when the snapshot volume is btrfs.
2. **`cp --reflink=always`** — near-instant on CoW filesystems
   (btrfs, XFS with reflink=1). Falls back to error if reflink is
   unsupported, so we know to try the next strategy.
3. **`cp`** — full copy. Reliable everywhere but slow for large
   archives. Acceptable fallback.

The strategy is detected once at startup (probe the snapshot volume)
and reused for all subsequent restores.

## Deployment Note: Hetzner

Hetzner dedicated servers and cloud VMs default to ext4, which does
not support reflinks. To get fast copies:

- Format the snapshot storage volume as **btrfs** (or XFS with
  `mkfs.xfs -m reflink=1`).
- On Hetzner Cloud: attach a volume, format as btrfs, mount at the
  snapshot storage path.
- Only the snapshot volume needs btrfs — the rest of the system stays
  on ext4.

---

## Design

### 1. `SnapshotCopier` utility (new: `packages/core/src/snapshot-copier.ts`)

Responsible for making fast copies of snapshot archives.

```ts
type CopyStrategy = "btrfs-snapshot" | "reflink" | "full-copy";

interface SnapshotCopier {
  /** Probe the snapshot volume and select the fastest strategy. */
  readonly strategy: CopyStrategy;

  /**
   * Copy a snapshot archive to a unique temporary path.
   * Returns the path to the copy. Caller must call cleanup() when done.
   */
  copy(srcPath: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
}
```

**Strategy detection** (run once at startup):

1. If `srcPath` is on a btrfs mount, try `btrfs subvolume snapshot`.
2. Else try `cp --reflink=always` on a test file in the snapshot dir.
3. If both fail, fall back to `cp`.

Log the selected strategy at startup so operators know what they're
getting.

**Copy implementation per strategy:**

- **btrfs-snapshot**: snapshot dir is a subvolume; create a snapshot
  to a temp subvolume name. Cleanup = `btrfs subvolume delete`.
- **reflink**: `cp --reflink=always <src> <tmp>`. Cleanup = `rm`.
- **full-copy**: `cp <src> <tmp>`. Cleanup = `rm`.

Temp paths live under `{snapshotDir}/.restore-copies/` with a UUID
name to avoid collisions.

### 2. Changes to `InstanceManager.executeRestore()`

Before calling `runtime.restore(ref, ...)`:

```ts
// Copy the archive so this restore doesn't conflict with concurrent ones
const copy = await this.snapshotCopier.copy(ref.paths.vmstate);
const ephemeralRef = { ...ref, paths: { ...ref.paths, vmstate: copy.path, memory: copy.path } };

try {
  handle = await this.runtime.restore(ephemeralRef, instanceId, restoreOptions);
} finally {
  await copy.cleanup();
}
```

This is the only call site that needs to change — the runtime sees a
unique archive path per restore, so no contention.

### 3. Remove `serializedRestore()` from `TenantManager`

With each restore operating on its own copy, the per-snapshot mutex is
no longer needed:

- Delete `restoreLocks` map and `serializedRestore()` method.
- In `restoreAndClaim()`, call `executeRestore()` directly instead of
  wrapping it in `serializedRestore()`.
- The 500ms post-failure cooldown also goes away.

### 4. `InstanceManager` constructor change

`InstanceManager` needs a `SnapshotCopier` instance. Injected via
constructor — created once at server startup after probing the volume.

---

## File Changes

| File | Change |
|---|---|
| `packages/core/src/snapshot-copier.ts` | **New.** `SnapshotCopier` class + strategy detection. |
| `apps/api/src/instance-manager.ts` | Accept `SnapshotCopier` in constructor. Use it in `executeRestore()`. |
| `apps/api/src/tenant-manager.ts` | Remove `restoreLocks`, `serializedRestore()`. Call `executeRestore()` directly. |
| `apps/api/src/server.ts` | Create `SnapshotCopier` at startup, pass to `InstanceManager`. |
| `packages/core/src/index.ts` | Export `SnapshotCopier`. |

---

## Testing

### Unit tests

- `snapshot-copier.test.ts`: mock `Bun.$` / `child_process` to verify
  strategy detection probes in the right order, and that each strategy
  produces a copy at a unique path and cleans up after.
- `tenant-manager.test.ts`: update "concurrent claims from different
  tenants for same workload all succeed (serialized restore)" — it
  should still pass but now without serialization (verify restores
  overlap in time).

### Integration test (podman)

- Set up a btrfs loopback volume as the snapshot dir.
- Create a golden snapshot, then fire N concurrent restores.
- Assert all N complete successfully and ran in parallel (wall time <
  N × single-restore time).

### E2E

- `multi-tenant-claim.e2e.test.ts` already tests concurrent claims —
  should pass without changes but run faster.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Disk space from copies (full-copy fallback) | Copies are ephemeral — cleaned up immediately after restore. Only N copies exist simultaneously for N concurrent restores. |
| btrfs detection wrong (e.g. nested mounts) | Strategy detection uses a real probe file, not mount sniffing. If the probe fails, we fall back gracefully. |
| Cleanup failure leaves orphan copies | Add a startup sweep of `{snapshotDir}/.restore-copies/` to delete stale entries older than 10 minutes. |
| Tenant snapshots also need this | Yes — tenant snapshots are per-tenant so contention is rare, but the same copy-before-restore path applies uniformly to all snapshot types. No special-casing needed. |

## Open Questions

- Should we log a warning at startup if the strategy is `full-copy`?
  Operators on ext4 may not realize they're paying a full copy per
  restore.
- For the S3 storage plan: when snapshots are fetched from S3 to local
  cache, the cached copy is already unique per fetch — does that
  interact with this, or should copy-before-restore always apply
  regardless?
