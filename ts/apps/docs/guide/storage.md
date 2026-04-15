# Storage

Boilerhouse uses a blob storage layer for persisting tenant overlay data, snapshots, and workload images. The storage system supports local disk, S3-compatible backends, and transparent encryption.

## Storage Architecture

```
                 ┌──────────────┐
                 │ BlobStore    │  (interface)
                 └──────┬───────┘
                        │
           ┌────────────┼────────────┐
           │            │            │
    ┌──────▼──────┐ ┌───▼────┐ ┌────▼─────────┐
    │ DiskCache   │ │ S3     │ │ TieredStore  │
    │ (local LRU) │ │ Backend│ │ (disk + S3)  │
    └─────────────┘ └────────┘ └──────────────┘
                        │
                 ┌──────▼───────┐
                 │ Encrypted    │  (optional wrapper)
                 │ Store        │
                 └──────────────┘
```

## Local Disk

The default storage backend. Overlays are stored as files on the local filesystem.

```bash
export STORAGE_PATH=./data  # default
```

All overlay archives are stored under `STORAGE_PATH` in a hierarchical key structure:

```
data/
├── tenants/alice/wkl_abc/overlay.tar.gz
├── tenants/bob/wkl_abc/overlay.tar.gz
└── tenants/carol/wkl_xyz/overlay.tar.gz
```

The disk cache uses LRU eviction to stay within configured size limits:

```bash
export OVERLAY_CACHE_DIR=./cache     # separate cache directory
export OVERLAY_CACHE_MAX_BYTES=10737418240  # 10 GB (default)
```

When the cache exceeds `OVERLAY_CACHE_MAX_BYTES`, the least recently accessed entries are evicted.

## S3 Backend

For production, use S3-compatible storage for durability and shared access across nodes.

```bash
export S3_ENABLED=true
export S3_BUCKET=my-boilerhouse-overlays
export S3_REGION=us-east-1
```

### AWS S3

```bash
export S3_ENABLED=true
export S3_BUCKET=my-boilerhouse-overlays
export S3_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
```

### S3-Compatible (MinIO, R2, Tigris)

```bash
export S3_ENABLED=true
export S3_BUCKET=boilerhouse
export S3_REGION=auto
export S3_ENDPOINT=http://localhost:9000  # MinIO
export AWS_ACCESS_KEY_ID=minioadmin
export AWS_SECRET_ACCESS_KEY=minioadmin
```

The S3 backend uses multipart upload for files larger than 5 MiB.

## Tiered Storage

When S3 is enabled, Boilerhouse automatically uses tiered storage:

1. **Read path:** check local disk cache first, fall back to S3
2. **Write path:** upload to S3, then cache locally
3. **Eviction:** local cache uses LRU, S3 retains everything

This gives you the durability of S3 with the performance of local reads. Concurrent requests for the same key are deduplicated — only one S3 download happens.

```bash
# Enable tiered storage
export S3_ENABLED=true
export S3_BUCKET=boilerhouse
export OVERLAY_CACHE_DIR=./cache
export OVERLAY_CACHE_MAX_BYTES=5368709120  # 5 GB local cache
```

## Encryption

Overlay archives can be encrypted at rest. Encryption is controlled per-workload:

```typescript
filesystem: {
  overlay_dirs: ["/workspace"],
  encrypt_overlays: true,  // default
}
```

### How It Works

- **Algorithm:** AES-256-GCM
- **Key derivation:** HKDF-SHA256 from the master secret + per-blob salt
- **Format:** `[12-byte IV][ciphertext][16-byte auth tag]`
- **Master key:** set via `BOILERHOUSE_SECRET_KEY` environment variable

Each overlay archive gets a unique encryption key derived from the master key and the blob's storage key. The authentication tag ensures data integrity.

### Configuration

```bash
# Required for encryption
export BOILERHOUSE_SECRET_KEY=your-secret-key-here
```

Without `BOILERHOUSE_SECRET_KEY`, encryption is disabled and overlays are stored in plaintext even if `encrypt_overlays: true` is set in the workload.

## What Gets Stored

| Data Type | Storage Key Pattern | Description |
|-----------|-------------------|-------------|
| Tenant overlay | `tenants/{tenantId}/{workloadId}/overlay.tar.gz` | Tenant filesystem state |
| Golden snapshot | `golden/{workloadId}/{snapshotId}` | Immutable workload reference |

## Storage for Kubernetes

The Kubernetes operator uses the same storage layer. Configure S3 credentials as environment variables on the operator Deployment, or mount them from a Kubernetes Secret:

```yaml
env:
  - name: S3_ENABLED
    value: "true"
  - name: S3_BUCKET
    value: boilerhouse-overlays
  - name: AWS_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: boilerhouse-s3
        key: access-key-id
```

## Development: MinIO

The included `docker-compose.yml` provides a MinIO instance for local S3-compatible storage:

```bash
docker compose up -d minio
```

MinIO is available at `http://localhost:9000` with default credentials `minioadmin:minioadmin`.
