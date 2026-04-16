# Quick Start

This guide gets you from zero to a running multi-tenant container in under 5 minutes using the Docker runtime.

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- Docker daemon running
- The Boilerhouse repository cloned locally

## 1. Install Dependencies

```bash
cd boilerhouse
bun install
```

## 2. Start the API Server

```bash
# Set a secret key for encrypting tenant data
export BOILERHOUSE_SECRET_KEY="my-dev-secret-key"

# Start with Docker runtime (default)
bun run apps/api/src/main.ts
```

The API server starts on `http://localhost:3000`.

## 3. Define a Workload

Create a workload file. Here's a minimal example using Alpine Linux:

```typescript
// workloads/minimal.workload.ts
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "minimal",
  version: "0.1.0",
  image: { dockerfile: "minimal/Dockerfile" },
  resources: { vcpus: 1, memory_mb: 128 },
  network: { access: "none" },
  idle: { timeout_seconds: 300, action: "hibernate" },
});
```

If you set `WORKLOADS_DIR=./workloads`, the API server auto-discovers and registers workload files on startup.

Alternatively, register via API:

```bash
curl -X POST http://localhost:3000/api/v1/workloads \
  -H "Content-Type: application/json" \
  -d '{
    "workload": { "name": "minimal", "version": "0.1.0" },
    "image": { "ref": "alpine:latest" },
    "resources": { "vcpus": 1, "memory_mb": 128 },
    "network": { "access": "none" },
    "idle": { "timeout_seconds": 300, "action": "hibernate" }
  }'
```

## 4. Wait for Workload Ready

The workload transitions through `creating` to `ready`. Check its status:

```bash
curl http://localhost:3000/api/v1/workloads/minimal
```

```json
{
  "name": "minimal",
  "version": "0.1.0",
  "status": "ready"
}
```

## 5. Claim an Instance

Claim a container for a tenant:

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/claim \
  -H "Content-Type: application/json" \
  -d '{"workload": "minimal"}'
```

```json
{
  "tenantId": "alice",
  "instanceId": "inst_a1b2c3",
  "endpoint": { "host": "127.0.0.1", "ports": [30001] },
  "source": "cold",
  "latencyMs": 2340
}
```

## 6. Interact with the Instance

Run a command inside the container:

```bash
curl -X POST http://localhost:3000/api/v1/instances/inst_a1b2c3/exec \
  -H "Content-Type: application/json" \
  -d '{"command": ["echo", "hello from boilerhouse"]}'
```

```json
{
  "exitCode": 0,
  "stdout": "hello from boilerhouse\n",
  "stderr": ""
}
```

View container logs:

```bash
curl http://localhost:3000/api/v1/instances/inst_a1b2c3/logs
```

## 7. Release the Tenant

When the tenant is done, release their claim. If the workload has `overlay_dirs` configured, Boilerhouse extracts and saves the tenant's filesystem state before shutting down.

```bash
curl -X POST http://localhost:3000/api/v1/tenants/alice/release \
  -H "Content-Type: application/json" \
  -d '{"workload": "minimal"}'
```

Next time Alice claims the same workload, her filesystem state is restored automatically.

## 8. Enable Pooling

For faster claim times, configure a pool. Add a `pool` section to your workload:

```typescript
export default defineWorkload({
  name: "minimal",
  version: "0.1.0",
  image: { ref: "alpine:latest" },
  resources: { vcpus: 1, memory_mb: 128 },
  network: { access: "none" },
  idle: { timeout_seconds: 300, action: "hibernate" },
  pool: { size: 3, max_fill_concurrency: 2 },
});
```

Boilerhouse pre-warms 3 instances. Claims now return in under a second:

```json
{
  "source": "pool",
  "latencyMs": 340
}
```

## Next Steps

- [Workloads](./workloads) — image sources, resources, health checks, idle policies
- [Tenants & Claims](./tenants) — multi-tenancy model, claim lifecycle
- [Networking & Security](./networking) — network access modes, credential injection
- [Docker Runtime](./runtime-docker) — Docker-specific configuration
- [Kubernetes Operator](./runtime-kubernetes) — deploying with K8s CRDs
