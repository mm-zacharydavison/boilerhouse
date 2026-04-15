# What is Boilerhouse?

Boilerhouse is a multi-tenant container orchestration platform. It spins up isolated containers on demand, manages their full lifecycle, and persists tenant state across sessions.

Built for platforms that give each user or AI agent their own running environment, Boilerhouse handles the hard parts: warm pooling for near-instant startup, filesystem snapshots so tenants resume where they left off, and a unified API that works identically across Docker and Kubernetes.

You define a workload once. Boilerhouse handles container creation, health checking, idle detection, hibernation, snapshot storage, and restoration.

## Use Cases

**AI agent hosting.** Give each user their own Claude Code, coding agent, or chatbot container with persistent workspace state. Boilerhouse manages the container lifecycle, injects API credentials via its secret gateway, and hibernates idle sessions to save resources. When the user returns, their environment is restored from the last snapshot.

**On-demand dev environments.** Spin up isolated dev containers per developer or per pull request. Each environment gets its own filesystem overlay, network scope, and resource limits. Tear it down when the PR merges, or hibernate it for later.

**Sandboxed execution.** Run untrusted code safely with network restrictions, resource limits, and seccomp profiles. Workload definitions control exactly which domains a container can reach, how much CPU and memory it gets, and what filesystem paths are persisted.

**Chat-triggered agents.** Connect Slack or Telegram to the trigger gateway. Incoming messages are routed to the correct tenant's container using configurable tenant resolution. If the container is hibernated, Boilerhouse restores it before delivering the message.

## How It Works

The end-to-end flow has five steps:

1. **Define a workload.** Write a workload config specifying the container image, resource limits, network rules, health checks, and idle policy. Workloads are registered via the API or loaded from a directory on disk.

2. **Pool warms up.** If the workload has a `pool` configuration, Boilerhouse pre-starts instances in the background. These sit in a "ready" state, waiting to be claimed.

3. **Tenant claims an instance.** An API call to `POST /tenants/:id/claim` binds a tenant to a running instance. If a warm instance is available in the pool, the claim completes in under a second. If the tenant has prior state, their filesystem overlay is injected before the instance is returned.

4. **Work happens.** The tenant interacts with their instance via HTTP, WebSocket, or exec. Boilerhouse tracks activity timestamps and routes requests through to the container's exposed ports.

5. **Idle timeout triggers release.** When a tenant's instance goes idle, Boilerhouse extracts the filesystem overlay, stores it (locally or in S3), and hibernates or destroys the container. The next claim for that tenant restores their state.

## Key Features

- **Warm pools.** Pre-warmed containers deliver sub-second claim times. The pool manager maintains a configured number of ready instances per workload and replenishes automatically after each claim.

- **Hibernation and snapshots.** When an instance goes idle, Boilerhouse captures its overlay filesystem and stores the data on disk or in S3 with optional encryption. The next claim for that tenant restores the snapshot into a fresh container.

- **Multi-runtime.** The same workload definition runs on Docker or Kubernetes. Switch runtimes with a single environment variable. The domain layer is runtime-agnostic; only the thin runtime adapter changes.

- **Tenant isolation.** Each tenant gets their own filesystem overlay, secret injection, and network scope. Secrets are stored encrypted and injected at claim time via credential rules on the workload definition.

- **Trigger system.** Webhook, Slack, Telegram, and cron adapters feed external events into the trigger gateway. Each trigger defines a tenant resolution strategy so events are routed to the correct container automatically.

- **Observability.** OpenTelemetry metrics and tracing are built in. Prometheus metrics are exposed on a configurable port. Structured logging via pino. An audit trail records every claim, release, idle timeout, and state transition.

## Project Status

Boilerhouse is pre-release software. The API and workload schema may change between versions. It is not yet recommended for production use without thorough evaluation.

Licensed under [BUSL-1.1](https://spdx.org/licenses/BUSL-1.1.html).
