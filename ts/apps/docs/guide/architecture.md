# Architecture

Boilerhouse is three Go binaries that share internal packages. All state lives in the Kubernetes API server — there is no database.

## System Overview

```
┌──────────────────────────────────────────────────────────┐
│                     Entry Points                          │
│  ┌─────────┐   ┌─────────────┐   ┌────────────────────┐   │
│  │ REST    │   │ Trigger     │   │ kubectl / CRDs     │   │
│  │ API     │   │ Gateway     │   │                    │   │
│  └────┬────┘   └──────┬──────┘   └──────────┬─────────┘   │
│       │               │                     │             │
│       ▼               ▼                     ▼             │
│  ┌────────────────────────────────────────────────────┐   │
│  │           Kubernetes API (CRDs = state)            │   │
│  │  Workload · Pool · Claim · Trigger                 │   │
│  └────────────────────────┬───────────────────────────┘   │
│                           │                               │
│                           ▼                               │
│  ┌────────────────────────────────────────────────────┐   │
│  │                Operator (controllers)              │   │
│  │  reconcile → Pods · Services · PVCs ·              │   │
│  │              NetworkPolicies · ConfigMaps          │   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## Repository Structure

```
boilerhouse/
├── go/                             # Go source (module github.com/zdavison/boilerhouse/go)
│   ├── cmd/
│   │   ├── api/                    # REST API entry point
│   │   ├── operator/               # Operator entry point
│   │   └── trigger/                # Trigger gateway entry point
│   ├── api/v1alpha1/               # CRD Go types (kubebuilder-annotated)
│   └── internal/
│       ├── api/                    # HTTP routes + WebSocket streaming
│       ├── operator/               # Controllers, translator, sidecar, snapshots
│       ├── trigger/                # Gateway, adapters, drivers, guards
│       ├── envoy/                  # Envoy config generation
│       └── o11y/                   # OpenTelemetry + structured logging
├── config/
│   ├── crd/bases-go/               # CRDs generated from Go types (authoritative)
│   ├── crd/bases/                  # Original CRDs from the TS implementation
│   └── deploy/                     # Kustomize deployment manifests
├── ts/
│   ├── apps/dashboard/             # Web dashboard (React) — still used
│   └── apps/docs/                  # This documentation site
├── workloads/                      # Example BoilerhouseWorkload YAML
└── scripts/                        # Dev helpers
```

## The Three Binaries

### Operator (`go/cmd/operator`)

A controller-runtime manager that owns four controllers:

| Controller | Reconciles | Produces |
|------------|-----------|----------|
| `WorkloadReconciler` | `BoilerhouseWorkload` | Image build/pull status, ConfigMaps for Envoy configuration |
| `PoolReconciler` | `BoilerhousePool` | Warm Pods labeled `boilerhouse.dev/pool-status` |
| `ClaimReconciler` | `BoilerhouseClaim` | Assigns a Pod to a tenant, creates Services/PVCs/NetworkPolicies, extracts overlays on release |
| `TriggerReconciler` | `BoilerhouseTrigger` | Status updates (the trigger gateway does the runtime work) |

Controllers are split by CRD, one file per controller in `go/internal/operator/`. The `translator.go` package converts a `BoilerhouseWorkload` spec into a `Pod` spec. `sidecar.go` injects the Envoy sidecar when `restricted` network access plus `credentials` is configured. `snapshots.go` manages the PVC-backed overlay archive flow.

The operator supports leader election (Kubernetes `Lease`) so multiple replicas can run for HA.

### API Server (`go/cmd/api`)

A `go-chi` HTTP server backed by the controller-runtime client. Every route is a thin translation of HTTP to a Kubernetes API call — create a workload, claim an instance, list pods as "instances". There is no business logic in the API layer; the controllers do the actual reconciliation.

The `/ws` endpoint streams Pod and Claim changes over WebSocket for the dashboard to consume.

### Trigger Gateway (`go/cmd/trigger`)

Watches `BoilerhouseTrigger` resources and starts one adapter per trigger:

| Adapter | Source |
|---------|--------|
| `webhook` | HTTP endpoints with optional HMAC signature verification |
| `telegram` | Long-polls the Telegram Bot API |
| `cron` | Runs on a cron schedule |

When an adapter fires, the gateway resolves the tenant, runs the guard chain (allowlist, API-based), creates a `BoilerhouseClaim`, waits for the claim to go `Active`, and forwards the event to the container via the appropriate driver (`claude-code`, `openclaw`, or generic HTTP).

## State Storage

All state lives in the Kubernetes API server. There is no SQLite, Postgres, or Drizzle.

| What | Where |
|------|-------|
| Workload definitions | `BoilerhouseWorkload` CRs |
| Pool configuration | `BoilerhousePool` CRs |
| Tenant claims | `BoilerhouseClaim` CRs |
| Trigger configuration | `BoilerhouseTrigger` CRs |
| Running instances | Pods with label `boilerhouse.dev/managed=true` |
| Per-workload config | ConfigMaps |
| Per-tenant secrets | Kubernetes `Secret` resources |
| Overlay archives | PVC-backed `tar.gz` files, accessed through a helper pod |
| Leader election | `coordination.k8s.io/Lease` |

This means the operator is stateless — it can be restarted at any time and reconstruct everything from the cluster.

## Instance State Machine

A `BoilerhouseClaim` moves through these phases:

```
Pending ──► Active ──► Releasing ──► Released
                │
                └──► Error
```

| Phase | Meaning |
|-------|---------|
| `Pending` | The claim has been created; the controller is selecting a Pod |
| `Active` | A Pod is assigned, healthy, and bound to this tenant |
| `Releasing` | The tenant released the claim; overlay is being extracted |
| `Released` | Overlay saved, Pod destroyed |
| `ReleaseFailed` | Release failed; manual cleanup may be required |
| `Error` | Claim could not be fulfilled |

The Pod itself uses the standard Kubernetes `Pod.status.phase` (`Pending`, `Running`, `Succeeded`, `Failed`, `Unknown`).

See [State Machines](../reference/state-machines) for the full per-CRD reference.

## Request Lifecycle: Claim

When a tenant claim request arrives at the API:

```
POST /api/v1/tenants/:id/claim
       │
       ▼
  Claim CR already Active for (tenant, workload)?
       │
      Yes ──► Return existing (fast path)
       │
      No
       │
       ▼
  Claim CR exists but Released? ──► Yes ──► Delete old claim, create new
       │
       ▼
  Create BoilerhouseClaim CR
       │
       ▼
  Poll claim.status.phase until Active or Error (30s timeout)
       │
       ▼
  Return claim (with instanceId, endpoint, source)
```

Inside the operator, the `ClaimReconciler` does the real work:

1. Look up the referenced `BoilerhouseWorkload`
2. Prefer a ready Pod from a matching pool (`source=pool`)
3. If the tenant has a saved overlay, restore it (`source=pool+data` or `cold+data`)
4. Otherwise cold-boot a new Pod (`source=cold`)
5. Label the Pod with `boilerhouse.dev/tenant=<id>`
6. Create Service / NetworkPolicy / Envoy ConfigMap as needed
7. Write endpoint back to `claim.status.endpoint`

## Observability

Each binary emits OpenTelemetry metrics and traces through the shared `go/internal/o11y` package. See [Observability](./observability) for the metric catalog.

## Deployment

All three binaries are packaged as container images (`go/Dockerfile.*`) and deployed via Kustomize manifests under `config/deploy/`. See [Deployment](./deployment).
