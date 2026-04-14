# Boilerhouse

Multi-tenant container orchestration for AI agents and SaaS products.

> **Status:** Pre-release — not yet ready for production use.

## Overview

Boilerhouse spins up isolated containers on demand, assigns them to tenants, and manages their full lifecycle — from cold boot through hibernation and teardown. It is designed for platforms that need to give each user (or agent) their own running environment with persistent state.

Some use cases:

- Giving users their own persistent AI agent container that only exists while they're using it
- Slack bot that runs AI agents to automatically debug alerts
- On-demand coding agents with per-user state

## Features

- **On-demand provisioning** — claim a container via API, webhook, Slack, Telegram, or cron trigger
- **Warm pools** — pre-start instances so tenants get sub-second claim times
- **Hibernation & snapshots** — suspend idle containers and restore tenant state on the next claim
- **Multi-runtime** — run workloads on Docker or Kubernetes with a unified API
- **Tenant isolation** — per-tenant secrets, filesystem overlays, and network scoping
- **Observability** — OpenTelemetry metrics/tracing and structured logging built in

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- [Docker](https://docs.docker.com/get-docker/) (for container workloads)
- Optionally, a Kubernetes cluster (minikube works)

### Install and run

```sh
git clone https://github.com/zdavison/boilerhouse.git
cd boilerhouse
bun install

# Start the API server and dashboard
bun run dev
```

The API server listens on `http://localhost:3000` and the dashboard on `http://localhost:3001`.

### Observability stack (optional)

```sh
docker compose up -d
# Grafana:    http://localhost:3003
# Prometheus: http://localhost:9090
```

## Documentation

Full documentation is available at the [Boilerhouse docs site](https://zdavison.github.io/boilerhouse/), covering architecture, core concepts, workload authoring, the REST API, CLI reference, and more.

## Project Structure

```
apps/
├── api/               # REST API server (Elysia)
├── operator/          # Kubernetes operator (CRDs, controllers)
├── cli/               # Command-line tool
├── dashboard/         # Web dashboard (React)
├── trigger-gateway/   # Event dispatcher service
└── docs/              # Documentation site (VitePress)

packages/
├── core/              # Domain types, workload schema, state machines
├── db/                # SQLite database (Drizzle ORM)
├── domain/            # Business logic (tenant, pool, instance managers)
├── runtime-docker/    # Docker runtime backend
├── k8s/               # Kubernetes client and manifests
├── storage/           # Blob storage (disk, S3, encrypted, tiered)
├── triggers/          # Trigger system and adapters
├── envoy-config/      # Envoy proxy configuration
└── o11y/              # Observability (Pino, OpenTelemetry)

workloads/             # Example workload definitions
tests/                 # Integration, E2E, and security tests
deploy/                # Prometheus, Grafana, Tempo configs
```

## Development

### Testing

Tests are organized into tiers. Only unit tests run by default.

```sh
# Unit tests
bun test

# Integration tests (require Docker / minikube)
bun test tests/integration/docker.integration.test.ts --timeout 60000
bun test tests/integration/kubernetes.integration.test.ts --timeout 60000

# E2E tests (all detected runtimes)
bun test tests/e2e/ --timeout 120000

# Security scans (via kadai)
bunx kadai run security
bunx kadai run security-breakout
```

To set up a minikube cluster for Kubernetes tests:

```sh
bunx kadai run minikube
```

### Linting and type checking

```sh
bun run lint
bun run typecheck
```

### Building

```sh
bun run build
```

Compiles the CLI, dashboard, and trigger gateway to standalone binaries in `dist/`.

## License

[Business Source License 1.1](LICENSE.md) — you may use Boilerhouse in production for internal and non-commercial purposes. Commercial use as a hosted multi-tenant orchestration service requires a commercial license. Each release converts to Apache 2.0 four years after publication.
