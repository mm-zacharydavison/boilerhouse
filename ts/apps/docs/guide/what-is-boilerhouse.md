# What is Boilerhouse?

::: warning AI-generated placeholder
These docs were drafted by an AI from the source and are a placeholder. They will be replaced with human-written documentation in future — expect gaps and inaccuracies until then.
:::

Boilerhouse is a Kubernetes-native, multi-tenant container orchestration platform. It lets you run isolated, on-demand containers for individual tenants — spinning them up when needed, hibernating them when idle, and restoring them with full state on the next request.

It was built for running AI agents (Claude Code, OpenClaw, Pi) in isolated containers, but works for any workload where you need per-tenant container isolation with lifecycle management.

## The Problem

You want to give each user their own container. Maybe it's a coding agent, a sandbox, or a dev environment. You need:

- **Isolation** — each user runs in their own container with restricted network access
- **State persistence** — when a user leaves, their work is saved; when they return, it's restored
- **Fast startup** — users shouldn't wait 30 seconds for a cold boot
- **Cost efficiency** — idle containers should be shut down, not left running
- **Declarative configuration** — workloads, pools, and triggers defined as Kubernetes resources and reconciled by an operator

Boilerhouse handles all of this on top of Kubernetes.

## How It Works

The core flow has five steps:

### 1. Define a Workload

A workload is a `BoilerhouseWorkload` Custom Resource that describes your container — its image, resources, network rules, health checks, and idle policy.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: my-agent
  namespace: boilerhouse
spec:
  version: "1.0.0"
  image:
    ref: my-registry/my-agent:latest
  resources:
    vcpus: 2
    memoryMb: 2048
    diskGb: 10
  network:
    access: restricted
    allowlist: ["api.openai.com"]
  idle:
    timeoutSeconds: 300
    action: hibernate
  filesystem:
    overlayDirs: ["/workspace"]
  health:
    intervalSeconds: 5
    unhealthyThreshold: 3
    httpGet:
      path: /health
      port: 8080
```

### 2. Apply It

```bash
kubectl apply -f my-agent.yaml
```

The operator picks it up, validates the spec, and transitions the workload to `Ready`. Pools and triggers work the same way — `kubectl apply` a `BoilerhousePool` or `BoilerhouseTrigger` to configure them.

### 3. Claim an Instance

When a tenant needs a container, claim one via the REST API. Boilerhouse finds the fastest path:

```bash
curl -X POST http://localhost:3000/api/v1/tenants/user-123/claim \
  -H "Content-Type: application/json" \
  -d '{"workload": "my-agent"}'
```

```json
{
  "tenantId": "user-123",
  "phase": "Active",
  "instanceId": "inst-abc123",
  "endpoint": { "host": "10.0.0.5", "port": 8080 },
  "source": "pool"
}
```

The `source` field tells you how the instance was provisioned:
- `existing` — tenant already had a running instance (instant)
- `pool` — grabbed from the pre-warmed pool (fast)
- `pool+data` — pool instance with tenant's previous state restored
- `cold` — booted from scratch (slower)
- `cold+data` — cold boot with state restored

### 4. Work

The tenant connects to their container endpoint and does their work. The operator monitors idle activity.

### 5. Hibernate & Restore

When the idle timeout fires, Boilerhouse extracts the tenant's filesystem overlay, saves it to a PVC, and destroys the Pod. Next time they claim, their state is restored automatically.

## Use Cases

- **AI agent hosting** — give each user their own Claude Code, Cursor, or custom agent container with API key injection and network restrictions
- **Sandboxed code execution** — run untrusted code in isolated containers with no network access
- **On-demand dev environments** — spin up per-user environments that persist state between sessions
- **Multi-tenant SaaS backends** — isolate tenant workloads with per-tenant resource limits and data separation

## Components

Boilerhouse is three Go binaries plus a dashboard, all running against a Kubernetes cluster.

### Operator

A controller-runtime operator that watches the four CRDs and reconciles them into Pods, Services, PVCs, NetworkPolicies, and ConfigMaps. Everything happens through the Kubernetes API — there is no database.

### API Server

A thin REST layer over the Kubernetes API (go-chi + controller-runtime client). It exposes `/api/v1/*` endpoints for creating workloads, claiming instances, listing pods as "instances", and streaming events over WebSocket.

### Trigger Gateway

Receives external events (webhooks, cron, Telegram) and creates `BoilerhouseClaim` resources. Guards (allowlist, API-based) authorize tenants before claims are created.

### Dashboard

A React app for inspecting workloads, pools, claims, and live instance events. It lives in `ts/apps/dashboard/` and talks to the API server.

## Next Steps

- [Quick Start](./quick-start) — get a container running in 5 minutes
- [Architecture](./architecture) — understand the system design
- [Workloads](./workloads) — learn how to define workloads
