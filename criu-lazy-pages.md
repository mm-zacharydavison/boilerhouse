# CRIU Lazy-Pages for Sub-Second Container Restore

Technical investigation into using CRIU's lazy-pages mechanism to reduce
boilerhouse container restore times from ~16 seconds to sub-second.

**Date:** 2026-03-23
**Status:** Research / Not Feasible Without Significant Upstream Work

---

## Executive Summary

CRIU lazy-pages is a real, working feature that uses Linux's userfaultfd
to restore processes with empty memory pages, faulting them in on demand.
It was designed for live migration (post-copy), not for local
checkpoint/restore acceleration. **Neither Podman nor crun expose
lazy-pages in their restore APIs.** There is no `--lazy-pages` flag, no
configuration option, and no open PRs to add one. Implementing this
would require either bypassing Podman entirely and calling CRIU directly,
or contributing lazy-pages support upstream to crun and Podman -- both
are substantial efforts with uncertain payoff given userfaultfd's
security restrictions and per-fault latency costs.

---

## 1. How CRIU Lazy-Pages Works

### The userfaultfd Mechanism

Linux's `userfaultfd(2)` syscall creates a file descriptor that receives
notifications when a process accesses a missing memory page. The kernel
delivers a `UFFD_EVENT_PAGEFAULT` message to the fd, and userspace
responds by copying page data into the faulting address via the
`UFFDIO_COPY` ioctl. The faulting thread blocks until the page is
delivered.

Key kernel features used:
- `UFFD_FEATURE_EVENT_FORK` -- track child processes after fork
- `UFFD_FEATURE_EVENT_REMAP` -- track mremap operations
- `UFFD_FEATURE_MISSING` -- notify on access to never-populated pages

### CRIU's Three-Component Architecture

Lazy restore involves three cooperating processes:

```
+-------------------+     unix socket     +-------------------+
|  criu restore     | <-----------------> |  criu lazy-pages   |
|  --lazy-pages     |    (uffd handoff)   |  daemon            |
+-------------------+                     +-------------------+
                                                |
                                          page requests
                                                |
                                          +-------------------+
                                          |  criu page-server  |
                                          |  --lazy-pages      |
                                          |  (has checkpoint   |
                                          |   images)          |
                                          +-------------------+
```

**Step 1: Start the lazy-pages daemon**
```sh
criu lazy-pages --images-dir /checkpoint --port 27 \
     --address 0.0.0.0 --page-server
```

**Step 2: Start the page server** (can be on a different host)
```sh
criu page-server --images-dir /checkpoint --port 27 \
     --address <lazy-pages-host> --lazy-pages
```

**Step 3: Restore with lazy-pages enabled**
```sh
criu restore --images-dir /checkpoint --lazy-pages
```

### What Happens During Restore

1. `criu restore --lazy-pages` restores the process tree but registers
   all private anonymous memory regions with userfaultfd instead of
   populating them from the checkpoint image.

2. The restore process hands the userfaultfd file descriptors to the
   lazy-pages daemon via a Unix socket (`lazy-pages.socket`).

3. The restored process resumes execution immediately with empty pages.

4. When the process touches an unpopulated page, the kernel generates a
   page fault. The lazy-pages daemon receives it, requests the page data
   from the page server (or reads it from local checkpoint images), and
   injects it via `UFFDIO_COPY`.

5. The lazy-pages daemon also does **background prefetching** -- it
   proactively pushes pages that haven't been faulted yet, using
   adaptive chunk sizes (64KB to 4MB) based on fault frequency.

### What Pages Are Lazily Loaded

Only **private anonymous pages** (heap, stack, anonymous mmap) are lazy.
The following are restored eagerly:
- File-backed mappings (restored from the filesystem, not checkpoint)
- Shared memory segments
- Pages in special VMAs (vDSO, vvar, etc.)

For a Node.js workload, the 255MB checkpoint is dominated by V8's JIT
code pages and heap. Most of these are private anonymous mappings and
would be candidates for lazy loading.

### The CRIU Protobuf API

CRIU's RPC interface (defined in `images/rpc.proto`) includes:
```protobuf
message criu_opts {
    optional bool lazy_pages = 48;
    optional criu_page_server_info ps = 11;
    // ...
}
```

The `lazy_pages` field is a first-class option in CRIU's protocol.

---

## 2. Podman Support: Does Not Exist

### Source Code Analysis

I searched the Podman, crun, and conmon-rs source code for any reference
to lazy-pages, lazy_pages, LazyPages, or userfaultfd. **Zero results.**

**Podman's restore path:**
- `libpod/oci_conmon_common.go` -- builds CLI args for the OCI runtime
  (crun/runc). The restore path passes `--restore <checkpoint-path>` to
  the runtime. No lazy-pages option.
- `pkg/checkpoint/checkpoint_restore.go` -- handles checkpoint import,
  metadata extraction, image pulling. Delegates to
  `runtime.RestoreContainer()`. No lazy-pages awareness.

**crun's CRIU integration** (`src/libcrun/criu.c`):
- Sets ~20 CriuOpts fields via the go-criu library:
  `tcp_established`, `tcp_close`, `file_locks`, `ext_unix_sk`,
  `manage_cgroups`, `network_lock`, etc.
- **Does NOT set `lazy_pages`.**
- No userfaultfd setup code.

**Podman's libpod API** (`/libpod/containers/{id}/restore`):
- Query parameters: `import`, `name`, `tcpClose`, `printStats`,
  `publishPorts`, `pod`, `ignoreRootFs`, etc.
- **No `lazyPages` parameter.**

### GitHub Issues and PRs

Searching the Podman repository on GitHub for "lazy-pages",
"lazy_pages", and "userfaultfd" returns **zero matching issues or PRs**.
The only tangentially related issue is #12106 (a general CRIU feature
request, closed), which mentions `pages_lazy: 0` in CRIU stats output
but does not request lazy-pages functionality.

There is no evidence that lazy-pages has ever been discussed, requested,
or worked on in the Podman project.

### Why Podman Doesn't Support It

Lazy-pages was designed for **live migration**, not local restore. The
typical use case is: dump a container on host A, restore it on host B
with lazy-pages, and stream memory pages from A to B as needed. This
avoids the latency of transferring all memory before the process can
resume.

Podman's checkpoint/restore is designed for:
- Container migration between hosts (full checkpoint, transfer, restore)
- Forensic analysis (checkpoint a suspicious container)
- Container hibernation (checkpoint to disk, restore later)

None of these use cases have demanded lazy-pages because the checkpoint
images are already local. The restore bottleneck is CRIU's internal
processing (rebuilding the process tree, restoring namespaces,
populating memory), not network transfer.

---

## 3. Feasibility: What Would It Take?

### Option A: Bypass Podman, Call CRIU Directly

This is technically possible but architecturally brutal.

**What you'd need to do:**

1. Extract the checkpoint archive (Podman packages CRIU images inside a
   tar.gz with additional metadata).

2. Start the `criu lazy-pages` daemon yourself, pointing it at the
   extracted checkpoint images directory.

3. Call `criu restore --lazy-pages` directly, outside of Podman's
   control, with all the correct namespace, cgroup, and rootfs
   configuration that Podman/crun normally sets up.

4. After restore, register the running container with Podman so it can
   manage the container lifecycle (exec, logs, stop, remove).

**Problems:**

- **You'd be reimplementing crun's CRIU integration.** crun sets ~20
  CRIU options, handles LSM profiles, mount namespaces, cgroup
  delegation, network namespaces, and notify callbacks. Reproducing
  this correctly is months of work and a maintenance nightmare.

- **Podman wouldn't know about the container.** You'd need to hack the
  Podman database or use `podman container cleanup` to reconcile state.

- **The lazy-pages daemon needs to run as long as the container runs**
  (until all pages are faulted in or background-prefetched). This adds
  a long-lived daemon per container instance.

- **Container networking.** Podman sets up CNI/netavark networking
  during restore. If you bypass Podman, you handle networking yourself.

**Verdict:** Not practical. The integration surface is too large.

### Option B: Contribute Lazy-Pages Support to crun + Podman

This is the "correct" approach but requires significant upstream work.

**Changes needed:**

1. **crun** (`src/libcrun/criu.c`):
   - Add `criu_set_lazy_pages(true)` when a new option is set
   - Start the lazy-pages daemon before calling `criu_restore()`
   - Manage the lazy-pages daemon lifecycle (it must run until all
     pages are served or the container exits)
   - Handle the lazy-pages Unix socket setup

2. **Podman** (`libpod/oci_conmon_common.go`):
   - Add `--lazy-pages` flag to `podman container restore`
   - Pass it through to the OCI runtime's restore spec
   - Expose in the REST API (`/libpod/containers/{id}/restore`)

3. **OCI Runtime Spec**:
   - The checkpoint/restore extensions to the OCI spec would need to
     include lazy-pages as an option. This is governed by the
     `checkpoint-restore/checkpointctl` project.

**Timeline estimate:** 3-6 months of upstream engagement, assuming
maintainer interest. There's no indication that Podman or crun
maintainers consider this a priority.

### Option C: Use CRIU's RPC Interface Directly from a Sidecar

CRIU has an RPC mode (`criu service`) that accepts commands via a Unix
socket using protobuf. You could:

1. Run `criu service` as a daemon
2. Send restore requests with `lazy_pages: true` via the RPC protocol
3. Manage the lazy-pages daemon as a sidecar process

This still requires reproducing all the namespace/cgroup/rootfs setup
that crun handles, so it has the same problems as Option A.

---

## 4. Risks and Limitations

### userfaultfd Security Restrictions

Since Linux 5.11, unprivileged userfaultfd is disabled by default:
```
/proc/sys/vm/unprivileged_userfaultfd = 0
```

CRIU's lazy-pages daemon runs as root (it must, to inject pages into
another process's address space), so this isn't a blocker for the daemon
itself. But:

- **Seccomp profiles** in container runtimes may block userfaultfd. The
  default Docker/Podman seccomp profile does NOT allow userfaultfd.
  The lazy-pages daemon runs outside the container, so this only matters
  if the restored process itself needs userfaultfd (it doesn't -- the
  daemon holds the uffd).

- **SELinux/AppArmor** may restrict the UFFDIO_COPY ioctl across
  security contexts.

### Page Fault Latency

Each page fault on a lazy page has this cost:
1. Kernel trap to userfaultfd handler (~microseconds)
2. Daemon reads page from checkpoint image or page server
3. Daemon copies page via UFFDIO_COPY ioctl
4. Kernel resumes faulting thread

**For local images:** ~10-50 microseconds per fault (disk I/O for
checkpoint image, ioctl overhead).

**For remote page server:** Adds network RTT per fault.

**For a Node.js workload:** V8's JIT compiler accesses code pages in
unpredictable patterns. On first HTTP request after restore, the process
would fault in JIT code pages, IC stubs, and heap objects. This could
mean hundreds or thousands of page faults in the first few milliseconds
of execution, causing a "page fault storm."

**Rough math:**
- 255MB checkpoint / 4KB pages = ~65,000 pages
- If 10% are touched in the first 100ms: ~6,500 faults
- At 50us per fault: ~325ms of page fault overhead
- But faults are serialized per-thread (kernel blocks the faulting
  thread), so with V8's single main thread, they're sequential

This means the first request after restore could see 300ms+ of latency
from page faults alone. Not sub-second restore -- sub-second *resume*
followed by degraded performance until pages warm up.

### Background Prefetching

CRIU's lazy-pages daemon does background prefetching (pushing pages that
haven't been faulted yet), using adaptive chunk sizes. This reduces the
number of demand faults but doesn't eliminate them. The prefetcher
competes with the demand-fault handler for the page server connection.

### What If the Lazy-Pages Daemon Dies?

If the daemon crashes or is killed:
- All future page faults become **SIGBUS** (unhandled userfaultfd fault)
- The restored process crashes
- There is no graceful degradation

This is a hard reliability requirement: the lazy-pages daemon must be as
reliable as the container runtime itself.

### Memory Pressure

With lazy pages, the kernel's view of the process's RSS is artificially
low (pages haven't been faulted in yet). This can confuse:
- OOM killer (may not kill the right process)
- Memory cgroup limits (process appears to use less memory than it will)
- Monitoring tools (RSS metrics are misleading until all pages are warm)

---

## 5. Architecture: How It Would Integrate with Boilerhouse

### Current Restore Flow

```
API (instance-manager.ts)
  |
  | HTTP POST to podmand
  v
podmand (main.ts:491 handleRestore)
  |
  | 1. Read archive from disk
  | 2. Decrypt if encrypted
  | 3. POST /libpod/containers/{name}/restore
  v
Podman REST API
  |
  | 4. Import checkpoint archive
  | 5. Call crun with --restore
  v
crun
  |
  | 6. Set up CriuOpts (20+ fields)
  | 7. Call criu_restore()
  v
CRIU
  |
  | 8. Rebuild process tree
  | 9. Restore namespaces, cgroups, FDs
  | 10. Populate all memory pages from images  <-- THIS IS THE BOTTLENECK
  | 11. Resume process
  v
Container running
```

Steps 8-10 account for the ~16 second restore time. Step 10 (memory
page population) is the dominant cost for a 255MB checkpoint.

### Hypothetical Lazy-Pages Flow

```
podmand
  |
  | 1. Read archive, decrypt
  | 2. Extract CRIU images from archive to temp dir
  | 3. Start criu lazy-pages daemon
  | 4. POST /libpod/containers/{name}/restore?lazyPages=true
  v
Podman → crun → CRIU
  |
  | 5. Rebuild process tree
  | 6. Restore namespaces, cgroups, FDs
  | 7. Register memory regions with userfaultfd (NOT populated)
  | 8. Hand uffd to lazy-pages daemon
  | 9. Resume process immediately
  v
Container "running" (pages empty)
  |
  | First request arrives
  | Page faults on JIT code → lazy-pages daemon serves from images
  | Background prefetcher pushes remaining pages
  v
Container fully warm (all pages populated)
```

### What podmand Would Need to Change

```typescript
// Hypothetical -- this API does not exist in Podman today
async restoreContainer(
  archive: Buffer,
  name: string,
  options: {
    publishPorts?: string[];
    pod?: string;
    lazyPages?: boolean;       // NEW: not supported
    lazyPagesSocket?: string;  // NEW: not supported
  }
): Promise<{ id: string; stats?: RestoreStats }>
```

podmand would also need to:
1. Extract CRIU images from the checkpoint tar to a temp directory
2. Start `criu lazy-pages` daemon before calling restore
3. Keep the lazy-pages daemon running until all pages are served
4. Monitor the daemon and kill the container if it dies
5. Clean up temp images after all pages are served

This fundamentally changes the restore lifecycle from "fire and forget"
to "long-lived daemon management."

---

## 6. Alternatives Worth Considering Instead

Given that lazy-pages is not exposed by Podman and would require
extensive upstream work, here are more practical approaches to
sub-second restore:

### A. Reduce Checkpoint Size

The 255MB is dominated by V8 heap and JIT code. Options:
- **V8 `--jitless` mode:** Disables JIT compilation entirely. Eliminates
  JIT code pages from the checkpoint. Massive size reduction but
  ~10-100x slower JavaScript execution.
- **Checkpoint after GC:** Force `global.gc()` before checkpoint to
  compact the heap. May reduce size by 20-50%.
- **V8 heap snapshot tuning:** `--max-old-space-size` to limit heap
  growth before checkpoint.

### B. Parallel Page Restore (Upstream CRIU)

CRIU has a `--restore-sibling` option and supports page-pipe
optimizations. The restore could be faster with:
- More aggressive parallelism in CRIU's page restore phase
- Using `splice()` instead of `read()`/`write()` for page data

### C. Switch to Firecracker/MicroVM

Firecracker natively supports MAP_PRIVATE mmap of snapshot memory,
giving instant CoW restore. This is what AWS Lambda uses. It requires
a different container runtime (microVM instead of Linux containers) but
is the industry-standard solution for sub-second restore.

Your existing `docs/plans/parallel-golden-restores.md` already documents
this as the gold standard approach.

### D. Pre-Warmed Instance Pool

Already discussed in your `parallel-golden-restores.md` as Option B.
Zero restore latency on claim at the cost of idle resource consumption.
This is the simplest path to "sub-second" user-perceived restore time.

### E. CRIU with Pre-Copy + Incremental Checkpoints

CRIU supports `--pre-dump` for incremental checkpointing. If the
workload doesn't change much between checkpoints, the restore can
focus on a small delta. This doesn't help with the first restore from
a golden image, but helps subsequent restores.

---

## 7. Conclusion

**CRIU lazy-pages is a technically sound mechanism** for demand-paged
process restore. It works, it's tested in CRIU's CI, and it's used for
live migration scenarios.

**It is not available through Podman.** The entire Podman/crun stack has
zero awareness of lazy-pages. No API, no CLI flag, no code paths. There
are no open issues or PRs requesting it.

**Even if it were available, the performance characteristics are
uncertain for our workload.** A Node.js process with V8 JIT code will
generate a burst of page faults on first request, potentially adding
300ms+ of latency. The process would "resume" instantly but wouldn't be
usefully responsive until enough pages are faulted in.

**The practical path to sub-second restore is not lazy-pages.** It's
either:
1. **Pre-warmed instance pool** (already planned, avoids restore
   entirely on the hot path)
2. **Checkpoint size reduction** (V8 tuning, post-GC checkpoint)
3. **Firecracker/microVM** (the real solution if restore latency is the
   primary concern, but a major architectural change)

Lazy-pages remains interesting as a long-term optimization if Podman
ever exposes it, but it should not be on the critical path for
achieving sub-second restore in boilerhouse.

---

## References

- CRIU lazy migration docs: https://criu.org/Lazy_migration
- CRIU source (`criu/uffd.c`): userfaultfd daemon implementation
- CRIU protobuf (`images/rpc.proto`): `lazy_pages = 48` field in CriuOpts
- CRIU test scripts: `test/jenkins/criu-lazy-pages.sh`, `criu-remote-lazy-pages.sh`
- Podman restore API: no lazy-pages support in any source file
- crun CRIU integration (`src/libcrun/criu.c`): no lazy_pages option set
- Linux userfaultfd: https://www.kernel.org/doc/html/latest/admin-guide/mm/userfaultfd.html
- Boilerhouse restore flow: `packages/runtime-podman/src/client.ts:324`
- Boilerhouse parallel restore plan: `docs/plans/parallel-golden-restores.md`
- AWS Lambda SnapStart (UFFD approach): USENIX ATC'23 paper
- CodeSandbox VM cloning (UFFD approach): https://codesandbox.io/blog/how-we-clone-a-running-vm-in-2-seconds
