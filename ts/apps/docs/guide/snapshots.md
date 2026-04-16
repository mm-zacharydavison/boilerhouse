# Snapshots & Hibernation

Boilerhouse can hibernate instances — saving their filesystem state to storage and restoring it on the next claim. This enables cost-effective idle management without losing tenant work.

## Hibernation

When a tenant's instance goes idle or is released, Boilerhouse can hibernate it:

1. **Pause** the container (if the runtime supports `pause`)
2. **Extract** the overlay directories as a compressed tar archive
3. **Save** the archive to blob storage (disk or S3)
4. **Destroy** the container

The tenant's state is now persisted. The container is gone, consuming zero resources.

### When Hibernation Triggers

Hibernation triggers in two ways:

- **Manual release** — `POST /tenants/:id/release` extracts overlays and hibernates
- **Idle timeout** — when the idle monitor fires (after `idle.timeout_seconds` of inactivity), the instance is automatically released and hibernated

The idle action is configured per-workload:

```typescript
idle: {
  timeout_seconds: 300,   // 5 minutes of inactivity
  action: "hibernate",    // save state (vs "destroy" which discards it)
}
```

## Restoration

When a hibernated tenant claims the same workload again, their state is restored:

1. A new container is created (from pool or cold boot)
2. The overlay archive is retrieved from blob storage
3. The archive is injected into the container via `tar -xz`
4. The container is ready with the tenant's previous state

This happens transparently — the claim response indicates the source:

```json
{
  "source": "pool+data",
  "latencyMs": 1200
}
```

## Overlay Directories

The directories that get persisted are declared in the workload config:

```typescript
filesystem: {
  overlay_dirs: ["/workspace", "/home/user"],
}
```

Only these directories are extracted and saved. System directories, installed packages, and other container state are not preserved — they come from the base image on each boot.

Choose overlay directories that contain tenant-specific data:
- `/workspace` — project files
- `/home/user` — user configuration, shell history
- `/root/.openclaw` — agent state

### What Gets Saved

The overlay extraction runs `tar czf` over the declared directories inside the container. Everything in those directories is included — files, symlinks, permissions, timestamps.

### What Doesn't Get Saved

- Running processes (they're killed on hibernation)
- In-memory state
- Network connections
- Files outside `overlay_dirs`
- Installed packages (use the base image for these)

## Encryption

Overlays are encrypted at rest by default:

```typescript
filesystem: {
  overlay_dirs: ["/workspace"],
  encrypt_overlays: true,  // default
}
```

Encryption uses AES-256-GCM with per-archive keys derived from the master `BOILERHOUSE_SECRET_KEY` via HKDF-SHA256. Each archive gets a unique IV and authentication tag.

To disable encryption (e.g., for debugging):

```typescript
filesystem: {
  overlay_dirs: ["/workspace"],
  encrypt_overlays: false,
}
```

## Storage Backend

Overlays are stored using Boilerhouse's blob storage layer. See [Storage](./storage) for backend configuration.

- **Disk** — default. Stored locally with LRU eviction.
- **S3** — stored in S3-compatible storage (AWS S3, MinIO, Cloudflare R2, Tigris). Recommended for production.
- **Tiered** — disk cache in front of S3. Reads hit disk first, falls back to S3.

## Snapshot Types

Boilerhouse tracks two types of snapshots:

| Type | Purpose |
|------|---------|
| `golden` | Immutable reference snapshot for a workload. Created once, shared across tenants. |
| `tenant` | Per-tenant state snapshot. Created on each hibernation, overwritten on next hibernation. |

Each tenant has at most one active overlay per workload. When a tenant hibernates, the previous overlay is replaced.

## Idle Detection

The idle monitor uses two signals to detect inactivity:

### Timeout

A simple timer. If no activity is recorded for `idle.timeout_seconds`, the instance is released.

### Watch Directories

For workloads where filesystem activity indicates usage:

```typescript
idle: {
  timeout_seconds: 60,
  action: "hibernate",
  watch_dirs: ["/root/.openclaw"],
}
```

Boilerhouse periodically checks the modification time of files in `watch_dirs`. If files have been modified since the last check, the idle timer resets. This catches activity that doesn't generate network traffic (e.g., an agent writing files locally).

The poller runs every few seconds and uses `find + stat` inside the container to get the latest modification time. A global semaphore limits concurrent polling to avoid overwhelming the runtime.
