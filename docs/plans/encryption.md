# End-to-End Encryption Plan

This document outlines how to implement end-to-end encryption for tenant data synced to remote sinks, ensuring data is encrypted at rest using tenant-provided keys.

## Goals

1. **Zero-knowledge encryption**: Boilerhouse never persists encryption keys - only the tenant knows their key
2. **Encryption at rest**: All data stored in sinks (S3, GCS, etc.) is encrypted client-side before upload
3. **Seamless integration**: Works with existing sync infrastructure (rclone sync/copy/bisync)
4. **Optional per-tenant**: Encryption is opt-in; tenants without keys use unencrypted sync

## Current State

| Component               | Status         | Notes                                              |
|-------------------------|----------------|----------------------------------------------------|
| RcloneSyncExecutor      | Implemented    | Executes rclone commands, supports bisync recovery |
| SinkAdapter interface   | Implemented    | Abstracts sink-specific rclone configuration       |
| Tenant claim flow       | Implemented    | `POST /api/v1/tenants/{id}/claim` with body        |
| Key handling            | Not done       | No encryption key support                          |

## Rclone Crypt Overview

Rclone provides a [crypt remote type](https://rclone.org/crypt/) that wraps any other remote and encrypts/decrypts on the fly:

- **Encryption algorithm**: NaCl SecretBox (XSalsa20 + Poly1305)
- **Key derivation**: scrypt from password + optional salt (password2)
- **File name encryption**: Optional (standard, obfuscate, or off)
- **Directory name encryption**: Optional
- **Chunk size**: Configurable (default 64KB)

The crypt remote wraps another remote:
```
mydata:bucket/path → crypt:mydata:bucket/path (encrypted)
```

### Rclone Crypt Configuration

Rclone crypt can be configured via:

1. **Config file** (`~/.config/rclone/rclone.conf`)
2. **Environment variables** (`RCLONE_CONFIG_*`)
3. **Command-line flags** (backend-specific options)
4. **On-the-fly remotes** (`:crypt:` syntax with options)

For dynamic per-tenant keys, we'll use **environment variables** or **command-line options**.

## Design

### API Changes

#### Claim Request

Add optional `encryptionKey` to claim request body:

```typescript
// POST /api/v1/tenants/{id}/claim
interface ClaimRequest {
  workloadId?: WorkloadId
  encryptionKey?: string        // Base64-encoded 32-byte key (256-bit)
  encryptionSalt?: string       // Optional: base64-encoded salt for key derivation
  encryptFilenames?: boolean    // Default: true - encrypt file/directory names
}
```

#### Response

Return encryption status in claim response:

```typescript
interface ClaimResponse {
  containerId: ContainerId
  endpoints: ContainerEndpoints
  encryption: {
    enabled: boolean
    filenameEncryption: boolean
  }
}
```

### Type Definitions

Add to `packages/core/src/types.ts`:

```typescript
export interface EncryptionConfig {
  /** Base64-encoded encryption key (32 bytes for AES-256 equivalent) */
  key: string
  /** Optional salt for key derivation (improves security) */
  salt?: string
  /** Encrypt file and directory names (default: true) */
  encryptFilenames?: boolean
  /** Filename encryption mode: 'standard' | 'obfuscate' | 'off' */
  filenameEncryption?: 'standard' | 'obfuscate' | 'off'
}

export interface TenantSession {
  tenantId: TenantId
  containerId: ContainerId
  workloadId: WorkloadId
  claimedAt: number
  encryption?: EncryptionConfig  // In-memory only, never persisted
}
```

### Encryption Key Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     Tenant Claim Flow                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Tenant calls POST /tenants/{id}/claim                       │
│     Body: { encryptionKey: "base64..." }                        │
│                                                                 │
│  2. API validates key format (32 bytes, valid base64)           │
│                                                                 │
│  3. Store key in TenantSession (in-memory only)                 │
│     ⚠️  NEVER persist key to database or logs                   │
│                                                                 │
│  4. On sync operations:                                         │
│     - If session has encryption key → use crypt remote          │
│     - If no key → use raw sink remote                           │
│                                                                 │
│  5. On release:                                                 │
│     - Final sync with encryption                                │
│     - Clear key from memory                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### RcloneSyncExecutor Changes

#### Crypt Remote Configuration

Rclone supports on-the-fly crypt configuration using environment variables:

```bash
# Configure underlying remote (S3)
export RCLONE_CONFIG_SINK_TYPE=s3
export RCLONE_CONFIG_SINK_BUCKET=my-bucket
export RCLONE_CONFIG_SINK_REGION=us-west-2

# Configure crypt remote wrapping the sink
export RCLONE_CONFIG_CRYPTSINK_TYPE=crypt
export RCLONE_CONFIG_CRYPTSINK_REMOTE=sink:path/to/data
export RCLONE_CONFIG_CRYPTSINK_PASSWORD=$(rclone obscure "tenant-key")
export RCLONE_CONFIG_CRYPTSINK_PASSWORD2=$(rclone obscure "tenant-salt")
export RCLONE_CONFIG_CRYPTSINK_FILENAME_ENCRYPTION=standard

# Use crypt remote in commands
rclone sync /local/path cryptsink:
```

#### Implementation

```typescript
// apps/api/lib/sync/rclone.ts

interface SyncOptions {
  localPath: string
  remotePath: string
  direction: 'upload' | 'download' | 'bidirectional'
  mode: 'sync' | 'copy'
  encryption?: EncryptionConfig
  // ... existing options
}

export class RcloneSyncExecutor {
  async sync(options: SyncOptions): Promise<SyncResult> {
    const env = this.buildEnvironment(options)
    const remotePath = options.encryption
      ? this.wrapWithCrypt(options.remotePath, options.encryption)
      : options.remotePath

    // ... execute rclone with env
  }

  private buildEnvironment(options: SyncOptions): NodeJS.ProcessEnv {
    const env = { ...process.env }

    if (options.encryption) {
      // Get obscured passwords (rclone requires passwords to be obscured)
      const obscuredKey = this.obscurePassword(options.encryption.key)
      const obscuredSalt = options.encryption.salt
        ? this.obscurePassword(options.encryption.salt)
        : undefined

      // Configure crypt remote via environment
      env.RCLONE_CONFIG_CRYPT_TYPE = 'crypt'
      env.RCLONE_CONFIG_CRYPT_REMOTE = options.remotePath
      env.RCLONE_CONFIG_CRYPT_PASSWORD = obscuredKey
      if (obscuredSalt) {
        env.RCLONE_CONFIG_CRYPT_PASSWORD2 = obscuredSalt
      }
      env.RCLONE_CONFIG_CRYPT_FILENAME_ENCRYPTION =
        options.encryption.filenameEncryption ?? 'standard'
    }

    return env
  }

  private wrapWithCrypt(remotePath: string, encryption: EncryptionConfig): string {
    // Remote path becomes the crypt remote name
    // e.g., ":s3:bucket/path" → "crypt:"
    return 'crypt:'
  }

  private obscurePassword(password: string): string {
    // Use rclone obscure to encode the password
    // This is required by rclone for environment variable passwords
    const result = spawnSync('rclone', ['obscure', password], {
      encoding: 'utf-8',
    })
    if (result.status !== 0) {
      throw new Error(`Failed to obscure password: ${result.stderr}`)
    }
    return result.stdout.trim()
  }
}
```

### SinkAdapter Changes

Extend `SinkAdapter` to support encryption wrapping:

```typescript
// apps/api/lib/sync/sink-adapter.ts

interface SinkAdapter {
  type: string
  buildRemotePath(sink: SinkConfig, tenantId: TenantId, sinkPath: string): string
  getRcloneArgs(sink: SinkConfig): string[]
  getRcloneEnv(sink: SinkConfig): Record<string, string>  // NEW
}
```

The new `getRcloneEnv` method returns environment variables for configuring the remote, which allows the crypt layer to wrap it properly.

### SyncCoordinator Changes

Update `SyncCoordinator` to pass encryption config through the sync chain:

```typescript
// apps/api/lib/sync/coordinator.ts

export class SyncCoordinator {
  private tenantSessions: Map<TenantId, TenantSession> = new Map()

  async onClaim(
    tenantId: TenantId,
    container: PoolContainer,
    workload: WorkloadSpec,
    options: { initialSync: boolean; encryption?: EncryptionConfig }
  ): Promise<void> {
    // Store encryption config in session
    if (options.encryption) {
      const session = this.tenantSessions.get(tenantId)
      if (session) {
        session.encryption = options.encryption
      }
    }

    // Pass encryption to sync operations
    await this.executeSyncMappings(tenantId, container, workload, 'download', {
      initialSync: options.initialSync,
      encryption: options.encryption,
    })
  }

  async onRelease(tenantId: TenantId, container: PoolContainer): Promise<void> {
    const session = this.tenantSessions.get(tenantId)

    // Final upload with encryption
    await this.executeSyncMappings(tenantId, container, workload, 'upload', {
      encryption: session?.encryption,
    })

    // Clear encryption key from memory
    if (session) {
      session.encryption = undefined
    }
    this.tenantSessions.delete(tenantId)
  }
}
```

### Security Considerations

#### Key Handling

| Requirement                | Implementation                                                |
|----------------------------|---------------------------------------------------------------|
| Never persist keys         | Store only in `TenantSession` Map (in-memory)                 |
| Clear on release           | Explicitly set `undefined` and delete session                 |
| No logging of keys         | Ensure keys are never logged (redact in error handlers)       |
| Secure key generation      | Document client-side key generation (32 bytes from CSPRNG)    |
| Key derivation             | Rclone uses scrypt internally for password → key derivation   |

#### Memory Security

```typescript
// Ensure keys are cleared from memory
function clearEncryptionConfig(session: TenantSession): void {
  if (session.encryption) {
    // Overwrite key data before clearing reference
    session.encryption.key = '0'.repeat(session.encryption.key.length)
    if (session.encryption.salt) {
      session.encryption.salt = '0'.repeat(session.encryption.salt.length)
    }
    session.encryption = undefined
  }
}
```

#### Validation

```typescript
function validateEncryptionKey(key: string): void {
  // Must be valid base64
  const decoded = Buffer.from(key, 'base64')

  // Must be exactly 32 bytes (256 bits)
  if (decoded.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes (256 bits)')
  }

  // Must not be all zeros (common mistake)
  if (decoded.every((b) => b === 0)) {
    throw new Error('Encryption key must not be all zeros')
  }
}
```

### Error Handling

#### Wrong Key Detection

When a tenant provides a wrong key for existing encrypted data:

```typescript
async function handleDecryptionError(
  error: Error,
  tenantId: TenantId
): Promise<SyncResult> {
  // Rclone crypt errors when key is wrong:
  // "failed to open: cipher: message authentication failed"
  // "failed to decode filename: invalid base64"

  if (
    error.message.includes('message authentication failed') ||
    error.message.includes('failed to decode filename')
  ) {
    return {
      success: false,
      error: 'DECRYPTION_FAILED',
      message: 'Failed to decrypt data. Please verify your encryption key.',
    }
  }

  throw error
}
```

#### API Error Response

```typescript
// 400 Bad Request for invalid key format
{
  "error": "INVALID_ENCRYPTION_KEY",
  "message": "Encryption key must be 32 bytes encoded as base64"
}

// 422 Unprocessable Entity for decryption failure
{
  "error": "DECRYPTION_FAILED",
  "message": "Failed to decrypt data. Please verify your encryption key."
}
```

### Bisync Considerations

Rclone bisync works with crypt remotes but has some caveats:

1. **First sync requires `--resync`**: Already handled by existing bisync recovery logic
2. **Filename encryption affects change detection**: Rclone handles this internally
3. **Checksum mismatch after re-encryption**: If key changes, bisync sees all files as changed

The existing `executeBisync` method's automatic `--resync` recovery handles most edge cases.


## API Documentation

### Enable Encryption on Claim

```bash
# Generate a 32-byte key (client-side)
KEY=$(openssl rand -base64 32)

# Claim with encryption
curl -X POST http://localhost:3000/api/v1/tenants/my-tenant/claim \
  -H "Content-Type: application/json" \
  -d '{
    "workloadId": "my-workload",
    "encryptionKey": "'"$KEY"'"
  }'
```

### Response

```json
{
  "containerId": "abc123",
  "endpoints": {
    "socket": "/var/run/boilerhouse/containers/abc123/socket.sock"
  },
  "encryption": {
    "enabled": true,
    "filenameEncryption": true
  }
}
```

### Key Generation Recommendations

Document for clients:

```javascript
// Node.js
const crypto = require('crypto')
const key = crypto.randomBytes(32).toString('base64')

// Browser
const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

// Python
import secrets, base64
key = base64.b64encode(secrets.token_bytes(32)).decode()
```

## Tasks

### Phase 1: Core Types and Validation

- [ ] 1.1 Add `EncryptionConfig` type to `packages/core/src/types.ts`
- [ ] 1.2 Add `TenantSession` type with encryption support
- [ ] 1.3 Implement `validateEncryptionKey()` function
- [ ] 1.4 Add encryption fields to claim request/response types

### Phase 2: RcloneSyncExecutor Changes

- [ ] 2.1 Add `obscurePassword()` method using `rclone obscure`
- [ ] 2.2 Implement `buildEnvironment()` for crypt remote configuration
- [ ] 2.3 Update `sync()` to use crypt remote when encryption provided
- [ ] 2.4 Add decryption error detection and handling
- [ ] 2.5 Add unit tests for encrypted sync operations

### Phase 3: SinkAdapter Updates

- [ ] 3.1 Add `getRcloneEnv()` method to `SinkAdapter` interface
- [ ] 3.2 Implement `getRcloneEnv()` for `S3SinkAdapter`
- [ ] 3.3 Update adapter registry and existing adapters

### Phase 4: SyncCoordinator Integration

- [ ] 4.1 Add `TenantSession` storage in `SyncCoordinator`
- [ ] 4.2 Update `onClaim()` to store and use encryption config
- [ ] 4.3 Update `onRelease()` to use encryption and clear key
- [ ] 4.4 Update `triggerSync()` to pass encryption config
- [ ] 4.5 Implement `clearEncryptionConfig()` for secure cleanup

### Phase 5: API Changes

- [ ] 5.1 Update claim endpoint to accept `encryptionKey`
- [ ] 5.2 Add encryption status to claim response
- [ ] 5.3 Add appropriate error responses for key validation failures
- [ ] 5.4 Add appropriate error responses for decryption failures

### Phase 6: Testing

- [ ] 6.1 Unit tests for key validation
- [ ] 6.2 Unit tests for rclone crypt environment configuration
- [ ] 6.3 Integration tests for encrypted upload/download
- [ ] 6.4 Integration tests for encrypted bisync
- [ ] 6.5 Test wrong key error handling
- [ ] 6.6 Test key clearing on release

### Phase 7: Documentation

- [ ] 7.1 Document encryption feature in API docs
- [ ] 7.2 Add key generation examples for common languages
- [ ] 7.3 Document migration path for existing data

## Alternative Approaches Considered

### 1. Application-Level Encryption (Rejected)

Encrypt data in application code before passing to rclone.

**Pros**: Full control over encryption algorithm
**Cons**:
- Breaks bisync (can't compare encrypted chunks)
- Larger codebase, more security audit surface
- Re-implementing what rclone crypt already does well

### 2. Rclone Config File Per-Tenant (Rejected)

Write temporary rclone.conf files with crypt configuration.

**Pros**: Standard rclone configuration approach
**Cons**:
- File cleanup complexity
- Race conditions with concurrent tenants
- Key written to disk (even if briefly)

### 3. Rclone Backend Flags (Chosen)

Use environment variables to configure crypt remote on-the-fly.

**Pros**:
- Keys never touch disk
- Works with existing rclone infrastructure
- Supports bisync natively
- Per-process isolation

**Cons**:
- Requires `rclone obscure` call for each sync
- Environment variables visible in `/proc` (mitigated by process isolation)

## Notes

- Encryption is **opt-in** per tenant - existing unencrypted workflows continue unchanged
- Keys are **never persisted** - losing the key means losing access to encrypted data
- **Filename encryption** is enabled by default for maximum privacy but can be disabled if clients need to browse sinks directly
- **No key recovery** - this is a feature, not a bug (zero-knowledge design)
- Consider adding **key rotation** support in future versions (would require re-encryption of all data)

## References

- [Rclone Crypt Documentation](https://rclone.org/crypt/)
- [Rclone Environment Variables](https://rclone.org/docs/#environment-variables)
- [NaCl SecretBox](https://nacl.cr.yp.to/secretbox.html)
