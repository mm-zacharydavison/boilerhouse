# Storage

Boilerhouse uses a blob store for overlay and snapshot data. The storage layer supports local disk, S3-compatible object storage, and a tiered mode that combines both. Encryption at rest is supported via AES-256-GCM.

## Overview

Three types of data pass through the storage layer:

- **Tenant overlays** -- filesystem state captured when a tenant's instance is released or hibernated, and restored on the next claim
- **Golden snapshots** -- baseline filesystem state for a workload, applied to new instances before tenant-specific overlays
- **Build logs** -- output from Dockerfile builds during workload registration

## Local Disk

The default backend stores blobs on the local filesystem. No external dependencies are required.

```bash
export STORAGE_PATH=./data    # Base directory (default: ./data)
```

Blobs are stored in a flat structure keyed by `{tenantId}/{workloadId}` or similar hierarchical keys. This backend is suitable for single-node deployments and development.

## S3 Backend

For production, use S3-compatible object storage for durable, shared storage across nodes:

```bash
export S3_ENABLED=true
export S3_BUCKET=boilerhouse-snapshots
export S3_REGION=us-east-1
export S3_ENDPOINT=https://s3.amazonaws.com
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
```

Any S3-compatible service works, including:

- **AWS S3**
- **MinIO** -- set `S3_ENDPOINT` to your MinIO server URL (e.g., `http://localhost:9000`)
- **Cloudflare R2** -- set `S3_ENDPOINT` to your R2 endpoint
- **DigitalOcean Spaces**

::: tip
The included `docker-compose.yml` starts a MinIO instance for local development. The default credentials are `minioadmin`/`minioadmin` and the bucket `boilerhouse` is created automatically.
:::

The S3 backend uses multipart uploads for files larger than 5 MiB with a concurrency of 4 parts.

## Tiered Storage

When S3 is enabled, the storage layer operates in tiered mode automatically:

- **Warm tier** (local disk) -- fast reads from a local LRU cache
- **Cold tier** (S3) -- durable, shared storage

The tiered store behaves as follows:

| Operation | Behavior |
|---|---|
| **Write** | Upload to S3 first (source of truth), then cache locally |
| **Read** | Check local cache; on miss, download from S3 and cache |
| **Delete** | Remove from both tiers |

Concurrent downloads of the same blob are deduplicated -- if multiple requests ask for the same key simultaneously, only one S3 download occurs.

## Overlay Cache

The overlay cache keeps frequently accessed tenant data on local disk for fast retrieval:

```bash
export OVERLAY_CACHE_DIR=./data/cache/overlays    # Cache location (default: ./data/cache/overlays)
export OVERLAY_CACHE_MAX_BYTES=10737418240         # Size limit in bytes (default: 10 GB)
```

The cache uses LRU (least recently used) eviction:

- Each blob's access time is tracked in memory
- When the total cache size exceeds `OVERLAY_CACHE_MAX_BYTES`, the least recently accessed blobs are deleted until the cache is within the limit
- The cache index is rebuilt from disk on startup by scanning the cache directory

::: info
The overlay cache is a performance optimization, not a durability layer. If the cache is cleared, blobs are re-downloaded from S3 on the next access. On single-node deployments without S3, the local disk store is the only copy.
:::

## Encryption

Overlay data is encrypted at rest before being written to the storage backend:

```bash
# Required. A random 32-byte hex string.
# Generate with: openssl rand -hex 32
export BOILERHOUSE_SECRET_KEY=a1b2c3...
```

### How It Works

Encryption uses AES-256-GCM with per-blob derived keys:

1. A unique encryption key is derived for each blob using HKDF-SHA256 from the master secret and the blob key (e.g., `tenantId/workloadId`)
2. A random 12-byte IV is generated for each encryption operation
3. The blob is encrypted with AES-256-GCM
4. The ciphertext is stored as: `[12-byte IV] [ciphertext] [16-byte auth tag]`
5. The GCM auth tag provides both confidentiality and integrity verification

The inner storage backend (local disk or S3) only ever sees ciphertext. Decryption happens transparently on read.

::: warning
`BOILERHOUSE_SECRET_KEY` must be consistent across all nodes and across restarts. Losing this key means losing access to all encrypted overlays and snapshots. Back it up securely.
:::

### Encryption Scope

- Tenant overlay archives are encrypted before storage
- The encryption layer wraps the underlying blob store transparently -- it works with both local disk and S3 backends
- Tenant secrets (API keys stored via the secrets API) are encrypted separately using the same master key

## Storage Architecture

The full storage stack, when all features are enabled:

```
Application Layer
      |
EncryptedStore        -- AES-256-GCM encryption/decryption
      |
TieredStore           -- warm cache + cold S3
    /     \
DiskCache   S3Backend -- LRU local cache / S3-compatible storage
```

When S3 is not enabled, the stack simplifies to:

```
Application Layer
      |
EncryptedStore
      |
DiskCache             -- local disk only
```

## Related Pages

- [Snapshots & Hibernation](./snapshots.md) -- how overlays are captured and restored
- [Observability](./observability.md) -- metrics for snapshot sizes and cache utilization
- [Configuration](./configuration.md) -- all storage-related environment variables
