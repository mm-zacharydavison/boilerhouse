# Quick Start

This tutorial walks you through installing Boilerhouse, registering a workload, and claiming your first instance using the Docker runtime.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Docker daemon running (`docker ps` should succeed)
- Node.js >= 20

## Install

Clone the repository and install dependencies:

```sh
git clone https://github.com/zdavison/boilerhouse.git
cd boilerhouse
bun install
```

## Configure

Boilerhouse needs two environment variables to start. Create a `.env` file or export them directly:

```sh
# A hex-encoded 32-byte key used to encrypt tenant secrets at rest.
# Generate one with: openssl rand -hex 32
export BOILERHOUSE_SECRET_KEY=$(openssl rand -hex 32)

# Use the Docker runtime (default, but explicit here for clarity).
export RUNTIME_TYPE=docker
```

::: tip
For local development you can skip `BOILERHOUSE_API_KEY` to disable authentication. In production, always set it to require Bearer token auth on all API requests.
:::

## Start the API

```sh
bun run apps/api/src/server.ts
```

You should see output like:

```
Boilerhouse API listening { port: 3000, host: "127.0.0.1" }
Prometheus metrics endpoint started { metricsPort: 9464 }
```

The API is now running at `http://localhost:3000`.

## Register a Workload

A workload defines the container image, resources, network rules, and health checks for a type of instance. Register a minimal HTTP server workload:

```sh
curl -s -X POST http://localhost:3000/api/v1/workloads \
  -H 'Content-Type: application/json' \
  -d '{
    "workload": { "name": "httpserver", "version": "0.1.0" },
    "image": { "dockerfile": "httpserver/Dockerfile" },
    "resources": { "vcpus": 1, "memory_mb": 256 },
    "network": {
      "access": "unrestricted",
      "expose": [{ "guest": 8080, "host_range": [30000, 31000] }]
    },
    "health": {
      "interval_seconds": 2,
      "unhealthy_threshold": 30,
      "http_get": { "path": "/", "port": 8080 }
    },
    "entrypoint": {
      "cmd": "/usr/local/bin/python3",
      "args": ["-m", "http.server", "8080"]
    },
    "idle": { "timeout_seconds": 300, "action": "hibernate" }
  }' | jq .
```

Response:

```json
{
  "workloadId": "wkl_abc123",
  "name": "httpserver",
  "version": "0.1.0",
  "status": "creating"
}
```

The workload status will transition from `creating` to `ready` once the image is built and the pool (if configured) is primed. Check its status:

```sh
curl -s http://localhost:3000/api/v1/workloads/httpserver | jq .status
```

Wait until it returns `"ready"` before proceeding.

::: info
If you have workload definition files on disk, you can point Boilerhouse at them with `WORKLOADS_DIR=./workloads` instead of registering via the API. The included `workloads/` directory has several examples.
:::

## Claim an Instance

Claim an instance for a tenant. This creates a running container bound to the tenant ID `my-first-tenant`:

```sh
curl -s -X POST http://localhost:3000/api/v1/tenants/my-first-tenant/claim \
  -H 'Content-Type: application/json' \
  -d '{ "workload": "httpserver" }' | jq .
```

Response:

```json
{
  "tenantId": "my-first-tenant",
  "instanceId": "ins_xyz789",
  "endpoint": {
    "host": "127.0.0.1",
    "ports": [{ "guest": 8080, "host": 30042 }]
  },
  "source": "cold",
  "latencyMs": 4823.5
}
```

The `source` field tells you where the instance came from:

| Source | Meaning |
|---|---|
| `pool` | Claimed from a pre-warmed pool (~500ms) |
| `cold` | Started from scratch (several seconds) |
| `cold+data` | Cold boot with tenant overlay restored |
| `existing` | Tenant already had an active instance |

## Connect to Your Instance

Use the `endpoint` from the claim response to reach the running container. The `host` port is mapped to the container's guest port:

```sh
curl http://127.0.0.1:30042/
```

You should see a directory listing from the Python HTTP server.

## Release the Instance

When the tenant is done, release the instance. This captures the filesystem overlay (if configured), hibernates or destroys the container, and frees the resources:

```sh
curl -s -X POST http://localhost:3000/api/v1/tenants/my-first-tenant/release \
  -H 'Content-Type: application/json' \
  -d '{ "workload": "httpserver" }' | jq .
```

Response:

```json
{
  "released": true
}
```

If the workload has `idle.action` set to `"hibernate"`, the next claim for this tenant will restore their filesystem state automatically.

## Next Steps

- [Workloads](./workloads.md) -- workload definition syntax, image sources, and configuration options
- [Pooling](./pooling.md) -- pre-warm instances for sub-second claims
- [Triggers](./triggers.md) -- route Slack, Telegram, webhook, and cron events to containers
- [Snapshots & Hibernation](./snapshots.md) -- how tenant state is persisted and restored
- [Runtime: Kubernetes](./runtime-kubernetes.md) -- deploy workloads to a Kubernetes cluster
- [Configuration](./configuration.md) -- environment variables and runtime settings
