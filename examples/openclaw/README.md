# OpenClaw Example

This example demonstrates how to use Boilerhouse to deploy and manage OpenClaw containers with persistent state sync via MinIO.

## Prerequisites

- Docker and Docker Compose
- Boilerhouse API server
- OpenClaw Docker image

## Quick Start

1. **Start MinIO** (from project root):
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

| Variable              | Default                 | Description         |
|-----------------------|-------------------------|---------------------|
| `BOILERHOUSE_API_URL` | `http://localhost:3000` | Boilerhouse API URL |
| `BOILERHOUSE_POOL_ID` | `default`               | Default pool ID     |
| `MINIO_ENDPOINT`      | `http://localhost:9000` | MinIO S3 endpoint   |
| `MINIO_ACCESS_KEY`    | `minioadmin`            | MinIO access key    |
| `MINIO_SECRET_KEY`    | `minioadmin`            | MinIO secret key    |
| `MINIO_BUCKET`        | `boilerhouse`           | MinIO bucket name   |

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

## Building OpenClaw Image

OpenClaw has an official Dockerfile in its repository:

```bash
# Clone OpenClaw
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw

# Build the image
cd /tmp/openclaw
docker build -t openclaw:latest .
```

Or use a pre-built image if available:
```bash
docker pull ghcr.io/openclaw/openclaw:latest
docker tag ghcr.io/openclaw/openclaw:latest openclaw:latest
```

## MinIO Credentials

| Setting    | Value                   |
|------------|-------------------------|
| Endpoint   | `localhost:9000`        |
| Access Key | `minioadmin`            |
| Secret Key | `minioadmin`            |
| Bucket     | `boilerhouse`           |
| Console    | `http://localhost:9001` |
