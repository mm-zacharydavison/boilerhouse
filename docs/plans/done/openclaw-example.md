# OpenClaw Example: Using Boilerhouse to Deploy OpenClaw Workloads

## Overview

This document outlines how to create an example deployment of OpenClaw using Boilerhouse as the container orchestration layer. The example will demonstrate:

1. Defining an OpenClaw workload specification
2. Deploying OpenClaw containers via Boilerhouse
3. Building a CLI tool to claim containers and interact with OpenClaw

## Goals

- Provide a working example of Boilerhouse in production use
- Demonstrate the workload configuration system
- Create a **generic Boilerhouse CLI** (`packages/cli`) that works with any workload
- Validate shell-based container interaction (`boilerhouse shell`)
- **Test state sync end-to-end using MinIO (local S3-compatible storage)**
- **CLI supports tenant-specific operations to verify sync isolation**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           openclaw-cli                                   │
│  claim → chat → release → sync:list → sync:verify                       │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
              ┌─────────────────────┴─────────────────────┐
              │ HTTP                                      │ HTTP
              ▼                                           ▼
┌─────────────────────────────┐         ┌─────────────────────────────────┐
│      Boilerhouse API        │         │     OpenClaw Gateway            │
│  POST /tenants/:id/claim    │         │  POST /v1/chat/completions      │
│  POST /tenants/:id/release  │         │  (OpenAI-compatible API)        │
│  → returns container port   │         │  Supports SSE streaming         │
└─────────────────────────────┘         └─────────────────────────────────┘
              │                                           ▲
              │ manages                                   │ exposed port
              ▼                                           │
        ┌──────────────────────────────────────────────────────────────┐
        │                    Container Pool                             │
        │  ┌──────────┐    ┌──────────┐    ┌──────────┐                │
        │  │ OpenClaw │    │ OpenClaw │    │ OpenClaw │                │
        │  │  :8080   │    │  :8081   │    │  :8082   │                │
        │  │  (idle)  │    │ (claimed)│    │  (idle)  │                │
        │  └────┬─────┘    └────┬─────┘    └────┬─────┘                │
        │       │               │               │                       │
        │  ~/.openclaw/    ~/.openclaw/    ~/.openclaw/                 │
        │   └─sessions/     └─sessions/     └─sessions/                 │
        └──────────────────────┬───────────────────────────────────────┘
                               │
                    rclone sync (on claim/release)
                               │
                               ▼
                         ┌───────────┐
                         │   MinIO   │
                         │  :9000    │
                         │           │
                         │ openclaw/ │
                         │  tenants/ │
                         │   {id}/   │
                         └───────────┘
```

**Key insight**: OpenClaw uses HTTP/WebSocket, not Unix sockets. Each container exposes an HTTP port for the OpenAI-compatible API.

---

## Directory Structure

```
examples/
└── openclaw/
    ├── README.md                    # Example documentation
    ├── docker-compose.yml           # MinIO stack for local testing
    ├── workload.yaml                # OpenClaw workload definition
    ├── test.sh                      # Integration test script
    └── test-sync.sh                 # Sync persistence test script

packages/
└── cli/                             # Generic Boilerhouse CLI
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts                 # CLI entry point
        ├── client.ts                # Boilerhouse API client
        ├── minio.ts                 # MinIO/S3 client for sync verification
        └── commands/
            ├── claim.ts
            ├── release.ts
            ├── status.ts
            ├── shell.ts             # Docker exec into container
            └── sync.ts              # sync:list, sync:cat, sync:verify, sync:clean
```

**Notes**:
- OpenClaw's Dockerfile is at https://github.com/openclaw/openclaw
- The CLI is **fully generic** - no workload-specific code
- Core commands: `claim`, `release`, `status`, `shell`, and `sync:*`
- The `shell` command runs `docker exec -it` to give interactive access
- Users run workload-specific commands inside the container (e.g., `openclaw chat`)

---

## Phase 1: OpenClaw Workload Definition

### Task 1.0: Set up MinIO for local S3-compatible storage

Create `examples/openclaw/docker-compose.yml`:

```yaml
version: '3.8'

services:
  minio:
    image: minio/minio:latest
    container_name: openclaw-minio
    ports:
      - "9000:9000"   # S3 API
      - "9001:9001"   # Console
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 3

  # Create the openclaw bucket on startup
  minio-setup:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin;
      mc mb local/openclaw --ignore-existing;
      mc anonymous set download local/openclaw;
      echo 'Bucket openclaw created';
      exit 0;
      "

volumes:
  minio-data:
```

**MinIO credentials for local development:**

| Setting         | Value         |
|-----------------|---------------|
| Endpoint        | `localhost:9000` |
| Access Key      | `minioadmin`  |
| Secret Key      | `minioadmin`  |
| Bucket          | `openclaw`    |
| Console URL     | `http://localhost:9001` |

### Task 1.1: Create workload YAML

Create `examples/openclaw/workload.yaml` defining the OpenClaw container with MinIO sync:

```yaml
id: openclaw
name: OpenClaw Agent
image: openclaw:latest  # Build from openclaw/Dockerfile

volumes:
  state:
    target: /home/node/.openclaw    # OpenClaw's default state directory
  secrets:
    target: /secrets
    read_only: true

# OpenClaw gateway configuration
environment:
  NODE_ENV: production
  HOME: /home/node
  TERM: xterm-256color
  # Gateway binding - use 'lan' for container access from host
  OPENCLAW_GATEWAY_BIND: lan
  # Note: API keys should be injected per-tenant via secrets mount

# Override default command to run gateway with explicit port
command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "8080"]

# Health check via HTTP GET to gateway
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s

# Expose the gateway port
ports:
  - container: 8080
    protocol: tcp

deploy:
  resources:
    limits:
      cpus: "2"
      memory: 2G

# Security (OpenClaw runs as 'node' user by default)
read_only: false   # OpenClaw needs to write to ~/.openclaw
user: "1000"       # 'node' user UID
network_mode: bridge

pool:
  min_size: 2
  max_size: 20
  idle_timeout: 10m

# Sync state to MinIO (local S3-compatible storage)
sync:
  sink:
    type: s3
    bucket: openclaw
    region: us-east-1                        # Required but ignored by MinIO
    endpoint: http://host.docker.internal:9000  # MinIO from inside container
    access_key_id: minioadmin
    secret_access_key: minioadmin
    prefix: tenants/${tenantId}/             # Each tenant gets isolated prefix
    rclone_flags:
      - "--s3-force-path-style"              # Required for MinIO

  mappings:
    # Sync session transcripts (JSONL files)
    - path: /home/node/.openclaw/sessions
      pattern: "*.jsonl"
      direction: bidirectional
      mode: sync
    # Sync auth profiles
    - path: /home/node/.openclaw
      pattern: "auth-profiles.json"
      direction: bidirectional
      mode: sync

  policy:
    on_claim: true      # Download tenant state when claiming
    on_release: true    # Upload tenant state when releasing
    manual: true        # Allow manual sync via API
```

**Key changes from original plan:**
- OpenClaw uses HTTP on port 8080, not Unix sockets
- State directory is `~/.openclaw` (mounted as `/home/node/.openclaw`)
- Sync includes both `sessions/*.jsonl` and `auth-profiles.json`
- Health check uses HTTP endpoint
- `read_only: false` because OpenClaw needs to write session files

### Task 1.2: Build OpenClaw Docker image

OpenClaw has an official Dockerfile in its repository at https://github.com/openclaw/openclaw.

**Option A: Build locally (recommended for development)**

```bash
# Clone OpenClaw
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw

# Build the image
cd /tmp/openclaw
docker build -t openclaw:latest .
```

**Option B: Use pre-built image (if available)**

Check GitHub Container Registry for published images:
```bash
# If published to GHCR
docker pull ghcr.io/openclaw/openclaw:latest
docker tag ghcr.io/openclaw/openclaw:latest openclaw:latest
```

**Note**: As of writing, check the OpenClaw releases page for official image availability.

**Dockerfile details** (from `openclaw/Dockerfile`):
- Base: `node:22-bookworm`
- Runs as non-root `node` user (UID 1000)
- Default command: `node dist/index.js`

**Gateway configuration** (from docker-compose.yml analysis):

The gateway is started with explicit flags:
```bash
# Command format
node dist/index.js gateway --bind <binding> --port <port>

# For container access (bind to all interfaces on LAN)
node dist/index.js gateway --bind lan --port 8080
```

**Environment variables** (alternative to flags):
- `OPENCLAW_GATEWAY_BIND` - Set to `lan` for container access (default: localhost only)
- `OPENCLAW_GATEWAY_PORT` - Port to listen on (default: 18789 in docker-compose)

**Workload command override**:
```yaml
# In workload.yaml
command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "8080"]
```

---

## Phase 2: CLI Tool Implementation

### Task 2.1: Set up CLI project

Create `packages/cli/package.json`:

```json
{
  "name": "@boilerhouse/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "boilerhouse": "./dist/index.js"
  },
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target node",
    "dev": "bun run src/index.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.0.0",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

This is a **generic Boilerhouse CLI** that works with any workload, not just OpenClaw.

### Task 2.2: Implement Boilerhouse API client

**Architecture Decision: Fully Generic CLI with Shell Access**

The Boilerhouse CLI is **completely workload-agnostic**. Instead of adding workload-specific commands, we provide a `shell` command that gives interactive access to claimed containers. Users can then run workload-specific commands directly inside the container.

**Benefits**:
- CLI stays simple and generic - works with any workload
- No need to maintain workload-specific plugins or extensions
- Users have full flexibility inside the container
- Easier to debug and experiment with workloads

**CLI Commands**:
```
boilerhouse claim <tenant-id> --pool <pool>   # Claim a container
boilerhouse release <tenant-id>                # Release container (syncs state)
boilerhouse status <tenant-id>                 # Check container status
boilerhouse shell <tenant-id>                  # Get shell inside container
boilerhouse sync:list <tenant-id>              # List synced files in MinIO
boilerhouse sync:cat <tenant-id> <path>        # View synced file content
boilerhouse sync:verify <tenant-a> <tenant-b>  # Verify tenant isolation
boilerhouse sync:clean <tenant-id>             # Delete tenant's synced files
```

**Example workflow with OpenClaw**:
```bash
# Claim a container as tenant "alice"
boilerhouse claim alice --pool openclaw

# Get a shell inside the container
boilerhouse shell alice
# Now inside container:
#   $ openclaw chat "Hello!"
#   $ openclaw sessions list
#   $ exit

# Release when done (syncs state to MinIO)
boilerhouse release alice
```

Create `packages/cli/src/client.ts`:

```typescript
export interface BoilerhouseClient {
  claim(tenantId: string, poolId: string): Promise<ClaimResult>
  release(tenantId: string): Promise<void>
  status(tenantId: string): Promise<TenantStatus>
  sync(tenantId: string, direction?: 'upload' | 'download' | 'both'): Promise<SyncResult>
}

export interface ClaimResult {
  containerId: string
  endpoints: {
    http: string      // HTTP endpoint for OpenAI-compatible API
    port: number      // Host port mapped to container
  }
}

export interface TenantStatus {
  status: 'cold' | 'warm' | 'provisioning'
  containerId?: string
  poolId?: string
  port?: number
  endpoints?: {
    http: string
  }
  lastActivity?: string
  syncStatus?: {
    lastSync?: string
    state: 'idle' | 'syncing' | 'error'
    error?: string
  }
}

export interface SyncResult {
  success: boolean
  results: Array<{
    success: boolean
    bytesTransferred?: number
    filesTransferred?: number
    errors?: string[]
  }>
}

export function createClient(baseUrl: string): BoilerhouseClient {
  const api = baseUrl.replace(/\/$/, '')

  return {
    async claim(tenantId, poolId) {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poolId }),
      })
      if (!res.ok) throw new Error(`Claim failed: ${await res.text()}`)
      return res.json()
    },

    async release(tenantId) {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sync: true }),  // Always sync on release
      })
      if (!res.ok) throw new Error(`Release failed: ${await res.text()}`)
    },

    async status(tenantId) {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/status`)
      if (!res.ok) throw new Error(`Status failed: ${await res.text()}`)
      return res.json()
    },

    async sync(tenantId, direction = 'both') {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      })
      if (!res.ok) throw new Error(`Sync failed: ${await res.text()}`)
      return res.json()
    },
  }
}
```

**Note**: Boilerhouse needs to be updated to return HTTP endpoint information in the claim response. This requires adding port mapping support to the container manager.

### Task 2.3: Implement shell command

The `shell` command uses `docker exec` to provide interactive access to claimed containers:

Create `packages/cli/src/commands/shell.ts`:

```typescript
import { spawn } from 'node:child_process'
import { createClient } from '../client'

export async function shellCommand(
  tenantId: string,
  options: { url: string; shell?: string }
) {
  const client = createClient(options.url)
  const status = await client.status(tenantId)

  if (status.status !== 'warm') {
    console.error('Container not ready. Run `claim` first.')
    process.exit(1)
  }

  if (!status.containerId) {
    console.error('No container ID found')
    process.exit(1)
  }

  const shell = options.shell ?? '/bin/sh'
  console.log(`Connecting to container ${status.containerId}...`)
  console.log('Type "exit" to leave the shell.\n')

  // Spawn interactive docker exec
  const proc = spawn('docker', ['exec', '-it', status.containerId, shell], {
    stdio: 'inherit',
  })

  proc.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}
```

**Usage inside container**:
```bash
# After running: boilerhouse shell alice
$ openclaw chat "Hello, OpenClaw!"
$ openclaw sessions list
$ exit
```

### Task 2.4: Implement CLI entry point

Create `packages/cli/src/index.ts`:

```typescript
#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { program } from 'commander'
import { createClient } from './client'
import { createMinioClient } from './minio'

const DEFAULT_API_URL = process.env.BOILERHOUSE_API_URL ?? 'http://localhost:3000'
const DEFAULT_POOL_ID = process.env.BOILERHOUSE_POOL_ID ?? 'default'

program
  .name('boilerhouse')
  .description('CLI for managing Boilerhouse containers')
  .version('0.1.0')

// ─────────────────────────────────────────────────────────────────────────────
// Core Commands
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('claim <tenant-id>')
  .description('Claim a container for a tenant')
  .option('-p, --pool <pool-id>', 'Pool ID', DEFAULT_POOL_ID)
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .action(async (tenantId, options) => {
    const client = createClient(options.url)
    const result = await client.claim(tenantId, options.pool)
    console.log(JSON.stringify(result, null, 2))
  })

program
  .command('release <tenant-id>')
  .description('Release a container (syncs state first)')
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .option('--no-sync', 'Skip sync on release')
  .action(async (tenantId, options) => {
    const client = createClient(options.url)
    await client.release(tenantId, { sync: options.sync })
    console.log(options.sync ? 'Released (state synced)' : 'Released (sync skipped)')
  })

program
  .command('status <tenant-id>')
  .description('Get tenant container status')
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .action(async (tenantId, options) => {
    const client = createClient(options.url)
    const status = await client.status(tenantId)
    console.log(JSON.stringify(status, null, 2))
  })

program
  .command('shell <tenant-id>')
  .description('Get interactive shell inside container')
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .option('-s, --shell <shell>', 'Shell to use', '/bin/sh')
  .action(async (tenantId, options) => {
    const client = createClient(options.url)
    const status = await client.status(tenantId)

    if (status.status !== 'warm') {
      console.error('Container not ready. Run `claim` first.')
      process.exit(1)
    }

    if (!status.containerId) {
      console.error('No container ID found')
      process.exit(1)
    }

    console.log(`Connecting to container ${status.containerId}...`)
    console.log('Type "exit" to leave the shell.\n')

    const proc = spawn('docker', ['exec', '-it', status.containerId, options.shell], {
      stdio: 'inherit',
    })

    proc.on('exit', (code) => {
      process.exit(code ?? 0)
    })
  })

// ─────────────────────────────────────────────────────────────────────────────
// Sync Commands (for verifying state sync with MinIO/S3)
// ─────────────────────────────────────────────────────────────────────────────

// ... sync commands defined in Task 2.6 ...

program.parse()
```

**Key differences from original design**:
- CLI is named `boilerhouse`, not `openclaw-cli`
- No workload-specific commands - just generic container management
- `shell` command provides interactive access to any workload
- Users run workload commands inside the container

### Task 2.5: Implement MinIO client for sync verification

Create `packages/cli/src/minio.ts`:

```typescript
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

export interface MinioConfig {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

const DEFAULT_CONFIG: MinioConfig = {
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  bucket: process.env.MINIO_BUCKET ?? 'openclaw',
}

export function createMinioClient(config: Partial<MinioConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true, // Required for MinIO
  })

  return {
    /**
     * List all files synced for a tenant
     */
    async listTenantFiles(tenantId: string): Promise<TenantFile[]> {
      const prefix = `tenants/${tenantId}/`
      const command = new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: prefix,
      })

      const response = await client.send(command)
      return (response.Contents ?? []).map((obj) => ({
        key: obj.Key!,
        relativePath: obj.Key!.replace(prefix, ''),
        size: obj.Size ?? 0,
        lastModified: obj.LastModified,
      }))
    },

    /**
     * Get the content of a synced file
     */
    async getFile(tenantId: string, relativePath: string): Promise<string> {
      const key = `tenants/${tenantId}/${relativePath}`
      const command = new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      })

      const response = await client.send(command)
      return response.Body?.transformToString() ?? ''
    },

    /**
     * Delete all files for a tenant (for testing cleanup)
     */
    async deleteTenantFiles(tenantId: string): Promise<number> {
      const files = await this.listTenantFiles(tenantId)
      let deleted = 0

      for (const file of files) {
        const command = new DeleteObjectCommand({
          Bucket: cfg.bucket,
          Key: file.key,
        })
        await client.send(command)
        deleted++
      }

      return deleted
    },

    /**
     * Verify tenant isolation - check that tenant A cannot see tenant B's files
     */
    async verifyIsolation(tenantA: string, tenantB: string): Promise<IsolationResult> {
      const filesA = await this.listTenantFiles(tenantA)
      const filesB = await this.listTenantFiles(tenantB)

      // Check for any cross-contamination
      const aKeysInB = filesA.filter((f) =>
        filesB.some((b) => b.relativePath === f.relativePath && b.key !== f.key)
      )

      return {
        tenantA: { fileCount: filesA.length, files: filesA.map((f) => f.relativePath) },
        tenantB: { fileCount: filesB.length, files: filesB.map((f) => f.relativePath) },
        isolated: aKeysInB.length === 0,
        crossContamination: aKeysInB.map((f) => f.relativePath),
      }
    },
  }
}

export interface TenantFile {
  key: string
  relativePath: string
  size: number
  lastModified?: Date
}

export interface IsolationResult {
  tenantA: { fileCount: number; files: string[] }
  tenantB: { fileCount: number; files: string[] }
  isolated: boolean
  crossContamination: string[]
}
```

### Task 2.6: Add sync verification CLI commands

Add these commands to `packages/cli/src/index.ts`:

```typescript
import { createMinioClient } from './minio'

// ... existing imports and commands ...

// MinIO configuration options (add to relevant commands)
const minioOptions = {
  endpoint: ['-e', '--minio-endpoint <url>', 'MinIO endpoint', 'http://localhost:9000'],
  accessKey: ['--minio-access-key <key>', 'MinIO access key', 'minioadmin'],
  secretKey: ['--minio-secret-key <key>', 'MinIO secret key', 'minioadmin'],
  bucket: ['-b', '--bucket <name>', 'MinIO bucket', 'openclaw'],
}

program
  .command('sync:list <tenant-id>')
  .description('List all synced files for a tenant in MinIO')
  .option(...minioOptions.endpoint)
  .option(...minioOptions.bucket)
  .action(async (tenantId, options) => {
    const minio = createMinioClient({
      endpoint: options.minioEndpoint,
      bucket: options.bucket,
    })

    const files = await minio.listTenantFiles(tenantId)

    if (files.length === 0) {
      console.log(`No files synced for tenant: ${tenantId}`)
      return
    }

    console.log(`Files synced for tenant ${tenantId}:`)
    console.log('─'.repeat(60))
    for (const file of files) {
      const size = file.size > 1024
        ? `${(file.size / 1024).toFixed(1)} KB`
        : `${file.size} B`
      const date = file.lastModified?.toISOString() ?? 'unknown'
      console.log(`  ${file.relativePath.padEnd(40)} ${size.padStart(10)}  ${date}`)
    }
    console.log('─'.repeat(60))
    console.log(`Total: ${files.length} files`)
  })

program
  .command('sync:cat <tenant-id> <path>')
  .description('Display content of a synced file')
  .option(...minioOptions.endpoint)
  .option(...minioOptions.bucket)
  .action(async (tenantId, path, options) => {
    const minio = createMinioClient({
      endpoint: options.minioEndpoint,
      bucket: options.bucket,
    })

    try {
      const content = await minio.getFile(tenantId, path)
      console.log(content)
    } catch (e) {
      console.error(`File not found: tenants/${tenantId}/${path}`)
      process.exit(1)
    }
  })

program
  .command('sync:verify <tenant-a> <tenant-b>')
  .description('Verify sync isolation between two tenants')
  .option(...minioOptions.endpoint)
  .option(...minioOptions.bucket)
  .action(async (tenantA, tenantB, options) => {
    const minio = createMinioClient({
      endpoint: options.minioEndpoint,
      bucket: options.bucket,
    })

    console.log(`Verifying isolation between ${tenantA} and ${tenantB}...`)
    const result = await minio.verifyIsolation(tenantA, tenantB)

    console.log(`\nTenant ${tenantA}: ${result.tenantA.fileCount} files`)
    for (const f of result.tenantA.files) console.log(`  - ${f}`)

    console.log(`\nTenant ${tenantB}: ${result.tenantB.fileCount} files`)
    for (const f of result.tenantB.files) console.log(`  - ${f}`)

    console.log('')
    if (result.isolated) {
      console.log('✓ Tenants are properly isolated')
    } else {
      console.log('✗ ISOLATION VIOLATION DETECTED!')
      console.log('Cross-contaminated files:', result.crossContamination)
      process.exit(1)
    }
  })

program
  .command('sync:clean <tenant-id>')
  .description('Delete all synced files for a tenant (for testing)')
  .option(...minioOptions.endpoint)
  .option(...minioOptions.bucket)
  .option('--force', 'Skip confirmation')
  .action(async (tenantId, options) => {
    if (!options.force) {
      console.log(`This will delete all synced files for tenant: ${tenantId}`)
      console.log('Use --force to skip this confirmation')
      process.exit(1)
    }

    const minio = createMinioClient({
      endpoint: options.minioEndpoint,
      bucket: options.bucket,
    })

    const deleted = await minio.deleteTenantFiles(tenantId)
    console.log(`Deleted ${deleted} files for tenant: ${tenantId}`)
  })
```

---

## Phase 3: Integration & Testing

### Task 3.1: Create example README

Create `examples/openclaw/README.md`:

```markdown
# OpenClaw Example

This example demonstrates how to use Boilerhouse to deploy and manage OpenClaw containers with persistent state sync via MinIO.

## Prerequisites

- Docker and Docker Compose
- Boilerhouse API server
- OpenClaw Docker image

## Quick Start

1. **Start MinIO** (local S3-compatible storage):
   ```bash
   docker-compose up -d minio minio-setup
   ```

2. **Verify MinIO is running**:
   - Console: http://localhost:9001 (minioadmin/minioadmin)
   - S3 API: http://localhost:9000

3. **Copy the workload to Boilerhouse**:
   ```bash
   cp workload.yaml ../../config/workloads/openclaw.yaml
   ```

4. **Start Boilerhouse**:
   ```bash
   # In project root
   bun run dev
   ```

5. **Install Boilerhouse CLI** (from project root):
   ```bash
   cd packages/cli
   bun install
   bun link  # Makes 'boilerhouse' command available globally
   ```

## CLI Usage

### Basic Operations

```bash
# Claim a container for a tenant
boilerhouse claim tenant-alice --pool openclaw

# Get a shell inside the container
boilerhouse shell tenant-alice

# Inside the container, run OpenClaw commands:
#   $ openclaw chat "Hello, OpenClaw!"
#   $ openclaw sessions list
#   $ exit

# Release the container (syncs state to MinIO)
boilerhouse release tenant-alice
```

### Sync Verification

```bash
# List synced files for a tenant
boilerhouse sync:list tenant-alice

# View a synced file
boilerhouse sync:cat tenant-alice sessions/abc123.jsonl

# Verify isolation between two tenants
boilerhouse sync:verify tenant-alice tenant-bob

# Clean up tenant files (for testing)
boilerhouse sync:clean tenant-alice --force
```

### Testing State Persistence

```bash
# 1. Claim container and interact with OpenClaw
boilerhouse claim tenant-test --pool openclaw
boilerhouse shell tenant-test
# Inside container:
#   $ openclaw chat "Remember: my favorite color is blue"
#   $ exit

# 2. Release container (uploads state to MinIO)
boilerhouse release tenant-test

# 3. Verify state was synced
boilerhouse sync:list tenant-test

# 4. Claim a NEW container (downloads state from MinIO)
boilerhouse claim tenant-test --pool openclaw
boilerhouse shell tenant-test
# Inside container:
#   $ openclaw chat "What is my favorite color?"
#   # OpenClaw should remember: blue
#   $ exit
```

## Environment Variables

| Variable               | Default                  | Description          |
|------------------------|--------------------------|----------------------|
| `BOILERHOUSE_API_URL`  | `http://localhost:3000`  | Boilerhouse API URL  |
| `BOILERHOUSE_POOL_ID`  | `default`                | Default pool ID      |
| `MINIO_ENDPOINT`       | `http://localhost:9000`  | MinIO S3 endpoint    |
| `MINIO_ACCESS_KEY`     | `minioadmin`             | MinIO access key     |
| `MINIO_SECRET_KEY`     | `minioadmin`             | MinIO secret key     |
| `MINIO_BUCKET`         | `openclaw`               | MinIO bucket name    |

## Verifying Tenant Isolation

The sync system ensures each tenant's state is isolated:

```bash
# Create state for tenant A
boilerhouse claim tenant-a --pool openclaw
boilerhouse shell tenant-a
# Inside: $ openclaw chat "Secret: A's password is 12345" && exit
boilerhouse release tenant-a

# Create state for tenant B
boilerhouse claim tenant-b --pool openclaw
boilerhouse shell tenant-b
# Inside: $ openclaw chat "Secret: B's password is 67890" && exit
boilerhouse release tenant-b

# Verify isolation
boilerhouse sync:verify tenant-a tenant-b
# Should show: ✓ Tenants are properly isolated

# Check tenant B cannot see tenant A's data
boilerhouse sync:list tenant-b
# Should only show tenant-b's files
```
```

### Task 3.2: Add integration test with sync verification

Create a comprehensive test script:

```bash
#!/bin/bash
# examples/openclaw/test.sh
# Tests claim/release cycle with state sync verification

set -e

TENANT_A="test-a-$(date +%s)"
TENANT_B="test-b-$(date +%s)"
POOL_ID="${BOILERHOUSE_POOL_ID:-openclaw}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"

echo "============================================"
echo "OpenClaw + Boilerhouse Integration Test"
echo "============================================"
echo ""

# Check MinIO is running
echo "0. Checking MinIO..."
if ! curl -s "$MINIO_ENDPOINT/minio/health/live" > /dev/null; then
  echo "   FAILED: MinIO not running at $MINIO_ENDPOINT"
  echo "   Run: docker-compose up -d minio minio-setup"
  exit 1
fi
echo "   ✓ MinIO is running"
echo ""

# Test Tenant A
echo "1. Testing Tenant A: $TENANT_A"
echo "   a. Claiming container..."
boilerhouse claim "$TENANT_A" -p "$POOL_ID"

echo "   b. Checking status..."
boilerhouse status "$TENANT_A"

echo "   c. Releasing container (triggers sync)..."
boilerhouse release "$TENANT_A"

echo "   d. Verifying files synced to MinIO..."
boilerhouse sync:list "$TENANT_A"
echo ""

# Test Tenant B
echo "2. Testing Tenant B: $TENANT_B"
echo "   a. Claiming container..."
boilerhouse claim "$TENANT_B" -p "$POOL_ID"

echo "   b. Releasing container..."
boilerhouse release "$TENANT_B"

echo "   c. Verifying files synced..."
boilerhouse sync:list "$TENANT_B"
echo ""

# Verify isolation
echo "3. Verifying tenant isolation..."
boilerhouse sync:verify "$TENANT_A" "$TENANT_B"
echo ""

# Test state persistence
echo "4. Testing state persistence for Tenant A..."
echo "   a. Re-claiming container (should restore state)..."
boilerhouse claim "$TENANT_A" -p "$POOL_ID"

echo "   b. Checking status..."
boilerhouse status "$TENANT_A"

echo "   c. Releasing again..."
boilerhouse release "$TENANT_A"
echo ""

# Cleanup
echo "5. Cleaning up test tenants..."
boilerhouse sync:clean "$TENANT_A" --force
boilerhouse sync:clean "$TENANT_B" --force
echo ""

echo "============================================"
echo "✓ All tests passed!"
echo "============================================"
```

### Task 3.3: Add sync persistence test

Create a focused test for state persistence:

```bash
#!/bin/bash
# examples/openclaw/test-sync.sh
# Tests that state persists across container recycling

set -e

TENANT_ID="sync-test-$(date +%s)"
POOL_ID="${BOILERHOUSE_POOL_ID:-openclaw}"
STATE_DIR="/var/lib/boilerhouse/states"

echo "State Sync Persistence Test"
echo "============================"
echo "Tenant: $TENANT_ID"
echo ""

# Step 1: Claim and create state
echo "1. Claiming container..."
CLAIM_RESULT=$(boilerhouse claim "$TENANT_ID" -p "$POOL_ID" 2>/dev/null)
CONTAINER_ID=$(echo "$CLAIM_RESULT" | jq -r '.containerId')
echo "   Container: $CONTAINER_ID"

echo "2. Creating test state file inside container..."
TEST_DATA="test-data-$(date +%s)"
docker exec "$CONTAINER_ID" sh -c "echo '$TEST_DATA' > /home/node/.openclaw/test.txt"
echo "   Wrote: $TEST_DATA"

echo "3. Releasing container (uploads to MinIO)..."
boilerhouse release "$TENANT_ID"

echo "4. Verifying file in MinIO..."
boilerhouse sync:list "$TENANT_ID"

MINIO_CONTENT=$(boilerhouse sync:cat "$TENANT_ID" test.txt 2>/dev/null || echo "")
if [ "$MINIO_CONTENT" != "$TEST_DATA" ]; then
  echo "   FAILED: MinIO content mismatch"
  echo "   Expected: $TEST_DATA"
  echo "   Got: $MINIO_CONTENT"
  exit 1
fi
echo "   ✓ File content matches"

# Step 2: Claim new container and verify state restored
echo ""
echo "5. Claiming NEW container..."
CLAIM_RESULT=$(boilerhouse claim "$TENANT_ID" -p "$POOL_ID" 2>/dev/null)
NEW_CONTAINER_ID=$(echo "$CLAIM_RESULT" | jq -r '.containerId')
echo "   New container: $NEW_CONTAINER_ID"

if [ "$NEW_CONTAINER_ID" = "$CONTAINER_ID" ]; then
  echo "   Note: Got same container (pool reuse)"
else
  echo "   Got different container (good for testing)"
fi

echo "6. Verifying state was restored..."
RESTORED_CONTENT=$(docker exec "$NEW_CONTAINER_ID" cat /home/node/.openclaw/test.txt 2>/dev/null || echo "")
if [ "$RESTORED_CONTENT" != "$TEST_DATA" ]; then
  echo "   FAILED: Restored content mismatch"
  echo "   Expected: $TEST_DATA"
  echo "   Got: $RESTORED_CONTENT"
  exit 1
fi
echo "   ✓ State restored correctly!"

# Cleanup
echo ""
echo "7. Cleaning up..."
boilerhouse release "$TENANT_ID"
boilerhouse sync:clean "$TENANT_ID" --force

echo ""
echo "============================"
echo "✓ Sync persistence test passed!"
echo "============================"
```

---

## Task Summary

| Phase | Task   | Description                                          | Priority |
|-------|--------|------------------------------------------------------|----------|
| 1     | 1.0    | Set up MinIO docker-compose                          | High     |
| 1     | 1.1    | Create OpenClaw workload.yaml with MinIO sync        | High     |
| 1     | 1.2    | Build OpenClaw image from openclaw repo              | High     |
| 2     | 2.1    | Set up generic CLI project (`packages/cli`)          | High     |
| 2     | 2.2    | Implement Boilerhouse API client                     | High     |
| 2     | 2.3    | Implement shell command (`docker exec`)              | High     |
| 2     | 2.4    | Implement CLI entry point (claim, release, status)   | High     |
| 2     | 2.5    | Implement MinIO client for sync verification         | High     |
| 2     | 2.6    | Add sync verification CLI commands                   | High     |
| 3     | 3.1    | Create example README with usage docs                | Medium   |
| 3     | 3.2    | Add integration test with sync verification          | Medium   |
| 3     | 3.3    | Add sync persistence test                            | Medium   |
**Note**: Phase B (port mapping) is **not required** for shell-based access. The `boilerhouse shell` command uses `docker exec` which doesn't need port exposure. Port mapping would only be needed if external clients need direct HTTP access to containers.

---

## Answered Questions (from OpenClaw codebase analysis)

### 1. Communication Protocol
**OpenClaw uses HTTP + WebSocket, NOT Unix sockets.**

- **HTTP API**: OpenAI-compatible endpoints at `/v1/chat/completions` and `/v1/responses`
- **WebSocket**: JSON message framing with `req`/`res`/`event` frame types
- **Handshake**: `connect.challenge` → client sends `ConnectParams` with auth

**CLI approach**: The Boilerhouse CLI uses `docker exec` for shell access, so users interact with OpenClaw directly inside the container using its native CLI (`openclaw chat`, etc.). No HTTP client code is needed in the Boilerhouse CLI.

### 2. Docker Image
**Official Dockerfile exists at `openclaw/Dockerfile`**

- Base: `node:22-bookworm`
- Runs as non-root `node` user
- Default command: `node dist/index.js gateway --allow-unconfigured`
- Use `--bind lan` for container access from host

### 3. Secrets Handling
**Credentials stored in `~/.openclaw/auth-profiles.json`**

- Supports API keys, tokens, and OAuth
- File is unencrypted JSON
- Schema: `{ type: "api_key"|"token"|"oauth", provider, key/token, ... }`

**For containers**: Mount secrets directory or set via environment variables.

### 4. State Files
**JSONL format in `~/.openclaw/sessions/`**

- Session transcripts: `{sessionId}.jsonl` (one message per line)
- Auth profiles: `auth-profiles.json`
- Each line: `{ message: {...} }` wrapper

**Sync mappings should include:**
```yaml
mappings:
  - path: /state/sessions
    pattern: "*.jsonl"
    direction: bidirectional
  - path: /state
    pattern: "auth-profiles.json"
    direction: bidirectional
```

### 5. Streaming Support
**Yes, via Server-Sent Events (SSE)**

- Content-Type: `text/event-stream`
- Event format: `data: <JSON>\n\n`
- Completion: `data: [DONE]\n\n`
- Works with `stream: true` parameter on `/v1/chat/completions`

### 6. MinIO vs S3
**Recommendation**: Support both via environment variables
- Development: MinIO (local)
- Production: Real S3 or S3-compatible service
- Same rclone config, different endpoint

---

## Resolved Questions

### 1. Gateway binding
**Resolved**: Configure via command-line flags or environment variables.

From OpenClaw's docker-compose.yml:
```yaml
command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "8080"]
```

| Method | Flag | Environment Variable | Values |
|--------|------|---------------------|--------|
| Binding | `--bind` | `OPENCLAW_GATEWAY_BIND` | `lan` (all interfaces), `localhost` (default) |
| Port | `--port` | `OPENCLAW_GATEWAY_PORT` | Port number (default: 18789) |

**For containers**: Use `--bind lan` to allow connections from the host network.

### 2. Health check
**Resolved**: HTTP GET to the gateway endpoint.

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

The gateway exposes a `/health` endpoint for liveness checks.

### 3. Session isolation
**Resolved**: OpenClaw is completely single-tenant.

Each OpenClaw container instance handles exactly one tenant. This matches Boilerhouse's architecture perfectly:
- One container per tenant at a time
- State sync per tenant to isolated S3 prefix
- Container state wiped on release before next tenant

---

## Dependencies

- Docker and Docker Compose
- Boilerhouse API running with Docker runtime
- MinIO (provided via docker-compose)
- OpenClaw Docker image
- Node.js/Bun for CLI
- AWS SDK for S3/MinIO access

---

## Success Criteria

### Core Functionality
1. Can define OpenClaw workload via YAML with MinIO sync config
2. Boilerhouse creates and pools OpenClaw containers
3. CLI can claim a container for a tenant (`boilerhouse claim`)
4. CLI can get interactive shell access to container (`boilerhouse shell`)
5. CLI can release the container back to the pool (`boilerhouse release`)
6. Users can run OpenClaw commands inside the container shell

### State Sync (Critical)
7. On release: state files upload to MinIO under `tenants/{tenantId}/`
8. On claim: state files download from MinIO into new container
9. State persists across container recycling (different container, same state)
10. CLI can list synced files for a tenant (`boilerhouse sync:list`)
11. CLI can view synced file contents (`boilerhouse sync:cat`)

### Tenant Isolation (Critical)
12. Each tenant's files are stored under isolated prefix in MinIO
13. CLI can verify isolation between tenants (`boilerhouse sync:verify`)
14. Tenant A cannot access Tenant B's synced files
15. Container state directories are wiped on release (before next tenant)
