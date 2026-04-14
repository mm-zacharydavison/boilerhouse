# What is Boilerhouse?

Boilerhouse is a multi-tenant container orchestration platform. It lets you run isolated, on-demand containers for individual tenants — spinning them up when needed, hibernating them when idle, and restoring them with full state on the next request.

It was built for running AI agents (Claude Code, OpenClaw, Pi) in isolated containers, but works for any workload where you need per-tenant container isolation with lifecycle management.

## The Problem

You want to give each user their own container. Maybe it's a coding agent, a sandbox, or a dev environment. You need:

- **Isolation** — each user runs in their own container with restricted network access
- **State persistence** — when a user leaves, their work is saved; when they return, it's restored
- **Fast startup** — users shouldn't wait 30 seconds for a cold boot
- **Cost efficiency** — idle containers should be shut down, not left running
- **Multi-runtime** — deploy to Docker on a single host or Kubernetes at scale

Boilerhouse handles all of this with a single API.

## How It Works

The core flow has five steps:

### 1. Define a Workload

A workload is a TypeScript file that describes your container — its image, resources, network rules, health checks, and idle policy.

```typescript
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "my-agent",
  version: "1.0.0",
  image: { ref: "my-registry/my-agent:latest" },
  resources: { vcpus: 2, memory_mb: 2048 },
  network: { access: "restricted", allowlist: ["api.openai.com"] },
  idle: { timeout_seconds: 300, action: "hibernate" },
  filesystem: { overlay_dirs: ["/workspace"] },
  health: {
    interval_seconds: 5,
    unhealthy_threshold: 3,
    http_get: { path: "/health", port: 8080 },
  },
});
```

### 2. Register the Workload

Register it with the API, or place the file in your workloads directory for auto-discovery.

```bash
curl -X POST http://localhost:3000/api/v1/workloads \
  -H "Content-Type: application/json" \
  -d @my-agent.json
```

### 3. Claim an Instance

When a tenant needs a container, claim one. Boilerhouse finds the fastest path:

```bash
curl -X POST http://localhost:3000/api/v1/tenants/user-123/claim \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

```json
{
  "tenantId": "user-123",
  "instanceId": "inst_abc123",
  "endpoint": { "host": "127.0.0.1", "ports": [30042] },
  "source": "pool",
  "latencyMs": 847
}
```

The `source` field tells you how the instance was provisioned:
- `existing` — tenant already had a running instance (instant)
- `pool` — grabbed from the pre-warmed pool (fast)
- `pool+data` — pool instance with tenant's previous state restored
- `cold` — booted from scratch (slower)
- `cold+data` — cold boot with state restored

### 4. Work

The tenant connects to their container endpoint and does their work. Boilerhouse monitors idle activity.

### 5. Hibernate & Restore

When the idle timeout fires, Boilerhouse extracts the tenant's filesystem overlay, saves it to storage, and destroys the container. Next time they claim, their state is restored automatically.

## Use Cases

- **AI agent hosting** — give each user their own Claude Code, Cursor, or custom agent container with API key injection and network restrictions
- **Sandboxed code execution** — run untrusted code in isolated containers with no network access
- **On-demand dev environments** — spin up per-user environments that persist state between sessions
- **Multi-tenant SaaS backends** — isolate tenant workloads with per-tenant resource limits and data separation

## Deployment Modes

Boilerhouse runs in two modes:

### API Server (Docker)

A standalone server that manages containers via the Docker daemon. Good for single-host deployments, development, and smaller workloads.

```bash
boilerhouse api start
```

### Kubernetes Operator

A full Kubernetes operator that manages workloads, pools, and claims as Custom Resources. Good for production, multi-node deployments.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: my-agent
spec:
  image:
    ref: my-registry/my-agent:latest
  resources:
    vcpus: 2
    memoryMb: 2048
```

Both modes share the same core domain logic — workload definitions, claim semantics, pooling, hibernation, and idle monitoring work identically.

## Next Steps

- [Quick Start](./quick-start) — get a container running in 5 minutes
- [Architecture](./architecture) — understand the system design
- [Workloads](./workloads) — learn how to define workloads
