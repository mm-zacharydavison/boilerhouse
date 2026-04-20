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

- **On-demand provisioning** — claim a container via API, webhook, Telegram, or cron trigger
- **Warm pools** — pre-start instances so tenants get sub-second claim times
- **Hibernation & snapshots** — suspend idle containers and restore tenant state on the next claim
- **Kubernetes-native** — workloads, pools, claims, and triggers are first-class Custom Resources
- **Tenant isolation** — per-tenant secrets, filesystem overlays, and NetworkPolicy-based network scoping
- **Observability** — OpenTelemetry metrics/tracing and structured logging built in

## Quick Start

### Prerequisites

macOS and Linux are supported.

- [Go](https://go.dev/) 1.26+
- [Docker](https://docs.docker.com/get-docker/) and [minikube](https://minikube.sigs.k8s.io/) (for local development)
- [Bun](https://bun.sh/) >= 1.3 (only for the dashboard and the `kadai` task runner)

Presets check every tool before running and print an OS-appropriate install hint if anything is missing — you don't need to have every prerequisite installed upfront.

### One-command demo

The fastest way to try Boilerhouse is a preset — it installs dependencies, bootstraps minikube, applies a workload, and drops you into a running dev loop.

```sh
git clone https://github.com/zdavison/boilerhouse.git
cd boilerhouse
bunx kadai run presets/claude-code   # or: presets/openclaw
```

You'll be prompted for a Telegram bot token ([@BotFather](https://t.me/BotFather)), an Anthropic API key, and a comma-separated Telegram allowlist. When the banner appears, DM the bot from an allowlisted account and you're running.

Presets are for **local demos**, not production. For production deployments, build and deploy the operator/API as in-cluster workloads.

### Manual setup

If you'd rather wire it up yourself:

```sh
bunx kadai run setup      # install Go + TS deps and dev tools
bunx kadai run minikube   # create and configure a local minikube cluster
bunx kadai run dev        # start operator + API + dashboard
```

The API listens on `http://localhost:3000` and the dashboard on `http://localhost:3001`. Ctrl+C stops both.

## Documentation

Full documentation is available at the [Boilerhouse docs site](https://zdavison.github.io/boilerhouse/), covering architecture, core concepts, workload authoring, the REST API, CRD reference, and more.

## Project Structure

```
go/                           # Go source (module github.com/zdavison/boilerhouse/go)
├── cmd/
│   ├── api/                  # REST API server (go-chi)
│   ├── operator/             # Kubernetes operator (controller-runtime)
│   └── trigger/              # Trigger gateway (webhook, cron, telegram)
├── api/v1alpha1/             # CRD Go types (kubebuilder-annotated)
└── internal/
    ├── api/                  # HTTP routes, WebSocket streaming
    ├── operator/             # Controllers, translator, snapshots, sidecar
    ├── trigger/              # Gateway, adapters, drivers, guards
    ├── envoy/                # Envoy proxy config generation
    └── o11y/                 # OpenTelemetry + structured logging

config/
├── crd/bases-go/             # CRDs generated from Go types (authoritative)
├── crd/bases/                # Original CRDs from the TS implementation
└── deploy/                   # Kustomize deployment manifests

ts/                           # Legacy TypeScript implementation
├── apps/dashboard/           # Web dashboard (React) — still used
└── apps/docs/                # Documentation site (VitePress)

workloads/                    # Example BoilerhouseWorkload YAML
```

## Development

### Testing

```sh
# Unit and controller tests (uses envtest — no real cluster needed)
bunx kadai run tests/unit

# E2E tests against a running minikube cluster
bunx kadai run tests/e2e-operator

# Run a single package or test
cd go
go test ./internal/operator/ -run TestClaimController -v
go test ./internal/api/ -run TestCreateWorkload -v
```

Controller tests in `go/internal/operator/` use `sigs.k8s.io/controller-runtime/pkg/envtest` (spins up a real apiserver+etcd locally — no kubelet, so Pods never actually run). API tests in `go/internal/api/` combine envtest with `httptest`.

### Tearing down

```sh
bunx kadai run nuke
```

Clean-slate teardown of the `boilerhouse` namespace: all Boilerhouse CRs, managed pods/services/PVCs, network policies, deployments, secrets, and configmaps. After this, a preset will re-prompt for tokens and the allowlist on its next run.

## License

[Business Source License 1.1](LICENSE.md) — you may use Boilerhouse in production for internal and non-commercial purposes. Commercial use as a hosted multi-tenant orchestration service requires a commercial license. Each release converts to Apache 2.0 four years after publication.
