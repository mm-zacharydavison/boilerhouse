# Snapshots and Hibernation

Snapshots capture the filesystem state of an [instance](./instances.md) so that [tenants](./tenants.md) can resume exactly where they left off. When a tenant's instance hibernates, the overlay directories are archived and stored. On the next claim, that archive is restored into a fresh instance.

## Hibernation

When an instance goes idle (no activity for the workload's `idle.timeout_seconds`) or is explicitly released with `action: "hibernate"`:

1. The idle monitor triggers a release.
2. The [workload's](./workloads.md) `overlay_dirs` are captured from the running container as a tar archive.
3. The archive is optionally encrypted with AES-256-GCM (controlled by `encrypt_overlays` in the workload definition).
4. The archive is written to the blob store.
5. The tenant's `data_overlay_ref` is updated to point to the new snapshot.
6. The instance is destroyed.
7. The [pool](./pooling.md) replenishes if configured.

The entire sequence is atomic from the tenant's perspective -- either the snapshot succeeds and the instance is destroyed, or the instance remains active and an error is reported.

## Snapshot Types

### Tenant Snapshots

Per-tenant filesystem state captured from overlay directories. Created automatically on hibernate or explicit release. Restored on the tenant's next claim for that workload.

Tenant snapshots are versioned by workload version. If the workload version changes between hibernate and restore, the snapshot is still applied but the workload's entrypoint may need to handle migration.

### Golden Snapshots

Baseline state for a specific workload version. Golden snapshots are created once and shared across all tenants as the starting point for a fresh instance. They are useful for workloads that need a pre-populated filesystem (e.g., pre-installed dependencies, pre-built assets).

Golden snapshots are not created automatically. They are produced by running an instance, preparing the desired state, and capturing it explicitly.

## Snapshot Lifecycle

Snapshots follow a state machine:

```
creating  -->  ready    (capture succeeded)
creating  -->  deleted  (capture failed, cleaned up)
ready     -->  expired  (TTL reached)
ready     -->  deleted  (manual deletion or cleanup)
expired   -->  deleted  (garbage collection)
```

| State      | Description                                      |
|------------|--------------------------------------------------|
| `creating` | Archive capture in progress                      |
| `ready`    | Stored and available for restore                 |
| `expired`  | Past its TTL, pending garbage collection         |
| `deleted`  | Removed from the blob store, terminal state      |

::: info
A tenant's active snapshot (referenced by `data_overlay_ref`) is never expired by TTL. Only unreferenced snapshots are subject to expiration.
:::

## Restore Flow

When a tenant with a prior snapshot claims a workload:

1. A pool instance or cold-boot instance starts normally.
2. The snapshot archive is fetched from the blob store (or the overlay cache if present).
3. The archive is decrypted if necessary and extracted into the container's overlay directories.
4. The container restarts to pick up the restored state.
5. Health checks confirm the instance is healthy.
6. The claim completes with `source: "pool+data"` or `"cold+data"` to indicate a restore occurred.

If the snapshot cannot be restored (corrupted archive, missing blob), the claim still succeeds with a fresh instance. The error is logged and the tenant's `data_overlay_ref` is cleared.

::: warning
Restore adds latency to the claim. The overhead depends on snapshot size and storage backend -- typically 1-5 seconds for disk, 2-10 seconds for S3. The overlay cache significantly reduces restore times for frequently accessed tenants.
:::

## Storage Backend

Snapshot archives are stored in the blob store. The backend is configured via environment variables.

### Disk (Default)

Stores snapshots on the local filesystem.

```sh
STORAGE_PATH=./data/snapshots
```

Suitable for development and single-node deployments. Not recommended for production clusters where instances may move between nodes.

### S3

Object storage for production deployments.

```sh
S3_ENABLED=true
S3_BUCKET=boilerhouse-snapshots
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.amazonaws.com   # Optional, for S3-compatible stores
```

Works with AWS S3, MinIO, Cloudflare R2, and any S3-compatible API.

### Tiered

Combines a warm disk cache with cold S3 storage. Snapshots are written to both disk and S3. Reads check disk first, falling back to S3 on cache miss.

```sh
S3_ENABLED=true
STORAGE_PATH=./data/snapshots
TIERED_STORAGE=true
```

This gives the latency benefits of local disk with the durability of object storage.

### Encryption

Overlay encryption is controlled per-workload via `encrypt_overlays` (default: `true`). When enabled, archives are encrypted with AES-256-GCM before being written to the blob store. The encryption key is derived from `BOILERHOUSE_SECRET_KEY`.

Encryption is applied at the application layer, independent of the storage backend. Even if the backend provides its own encryption (e.g., S3 SSE), Boilerhouse encrypts the archive before upload.

See [Storage](./storage.md) for full backend configuration details.

## Overlay Filesystem

### How Overlays Work

Overlay directories declared in the workload's `overlay_dirs` are the only paths captured during hibernation. Everything outside these directories is ephemeral and lost when the container is destroyed.

Choose overlay paths carefully:
- Include directories where the application writes persistent state (workspaces, databases, config).
- Exclude directories with large, reproducible content (package caches, build artifacts) to keep snapshots small.

### Overlay Cache

Frequently accessed snapshots are cached on the local filesystem to reduce restore latency.

| Variable                 | Default                    | Description                  |
|--------------------------|----------------------------|------------------------------|
| `OVERLAY_CACHE_DIR`      | `./data/cache/overlays`    | Local cache directory        |
| `OVERLAY_CACHE_MAX_BYTES`| `10737418240` (10 GB)      | Maximum cache size in bytes  |

The cache uses LRU (least recently used) eviction. When the cache is full, the least recently accessed entries are removed to make room for new ones.

::: tip
For workloads with many active tenants, size the overlay cache to hold at least the working set of frequently-claimed tenant snapshots. Monitor cache hit rate to determine if the cache is large enough.
:::
