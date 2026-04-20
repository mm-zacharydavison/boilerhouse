# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Boilerhouse

Multi-tenant container orchestration for AI agents and SaaS products — spins up isolated containers on demand, assigns them to tenants, and manages lifecycle (claim → hibernate → snapshot → teardown). Pre-release.

The Go rewrite has been merged into `main`. The legacy TypeScript implementation still lives in `ts/` (Elysia API, React dashboard, CLI, docs site) and is the source referenced by `README.md`. All new work happens in `go/`.

## Architecture

Three Go binaries share internal packages; all state lives in the Kubernetes API server (CRDs + native resources — no database):

- `go/cmd/operator/` — K8s operator. Watches CRDs, reconciles Pods/PVCs/Services/NetworkPolicies. Controllers live in `go/internal/operator/` (one file per CRD: `workload_controller.go`, `pool_controller.go`, `claim_controller.go`, `trigger_controller.go`, plus `translator.go` for Workload → Pod spec, `sidecar.go`, `snapshots.go`).
- `go/cmd/api/` — REST API server (go-chi). Thin HTTP → K8s translation. Routes in `go/internal/api/routes_*.go`; WebSocket streaming in `websocket.go`.
- `go/cmd/trigger/` — Trigger gateway. Receives external events (webhook, cron, telegram) and creates Claim CRs. Adapters in `go/internal/trigger/adapter_*.go`.

CRD Go types: `go/api/v1alpha1/` (kubebuilder-annotated). The four CRDs are **Workload** (template), **Pool** (pre-warmed instances), **Claim** (tenant ownership of an instance), **Trigger** (external event source).

CRD YAML is generated from the Go types into `config/crd/bases-go/` by `bunx kadai run codegen`. Never hand-edit — regenerate.

Shared packages: `go/internal/o11y/` (OpenTelemetry + structured logging), `go/internal/envoy/` (Envoy config generation).

## Development

### Prerequisites

- Go 1.26+ (see `go/go.mod`)
- minikube + Docker
- envtest binaries (installed automatically by test scripts)

### Kadai actions (run via `bunx kadai run <id>`)

| id | purpose |
| --- | --- |
| `setup` | Install all deps (Go + TS + dev tools) |
| `minikube` | Set up local minikube cluster (one-time) |
| `dev` | Start operator + API against minikube; Ctrl+C kills both |
| `nuke` | Delete all Boilerhouse resources from the cluster |
| `tests/unit` | Run Go unit tests (includes envtest controller tests) |
| `tests/e2e-operator` | Run E2E tests against the operator on minikube |

### Running a binary alone

```sh
cd go
# Operator
KUBECONFIG=<your-kubeconfig> K8S_NAMESPACE=boilerhouse go run ./cmd/operator/
# API
KUBECONFIG=<your-kubeconfig> K8S_NAMESPACE=boilerhouse PORT=3000 go run ./cmd/api/
# Trigger gateway
KUBECONFIG=<your-kubeconfig> K8S_NAMESPACE=boilerhouse go run ./cmd/trigger/
```

## Testing

```sh
# Everything (envtest-based, no real cluster needed)
bunx kadai run tests/unit

# Or manually
cd go
export KUBEBUILDER_ASSETS="$(setup-envtest use -p path)"
go test ./... -timeout 300s

# Single package / single test
go test ./internal/operator/ -run TestClaimController -v
go test ./internal/api/ -run TestCreateWorkload -v
```

Controller tests in `go/internal/operator/` use `sigs.k8s.io/controller-runtime/pkg/envtest` (spins up a real apiserver+etcd locally — no kubelet, so pods never actually run). API tests in `go/internal/api/` combine envtest with `httptest`. Trigger gateway tests in `go/internal/trigger/` are mostly unit-level.

E2E tests (`tests/e2e-operator`) require a running minikube cluster and exercise the full reconcile loop with real pods.

## Key directories

```
go/                   Go source (module github.com/zdavison/boilerhouse/go)
  cmd/                entry points: api, operator, trigger
  internal/           api, operator, trigger, o11y, envoy
  api/v1alpha1/       CRD types (kubebuilder)
config/crd/bases-go/  CRDs generated from Go types (run `bunx kadai run codegen`)
config/deploy/        kustomize deployment manifests
workloads/            example Workload YAML
ts/                   legacy TypeScript implementation (apps + packages)
docs/                 specs, deployment notes, plans
```
