# Boilerhouse

NOT-RELEASED — Go port on `experimental/go` branch.

## Architecture

Boilerhouse is a multi-tenant container orchestration platform built on Kubernetes. Three Go binaries share internal packages:

- `go/cmd/operator/` — K8s operator. Watches CRDs, reconciles Pods/PVCs/Services/NetworkPolicies.
- `go/cmd/api/` — REST API server. Thin translation layer between HTTP and K8s API.
- `go/cmd/trigger/` — Trigger gateway. Receives external events, creates Claims.

All state lives in the K8s API server (CRDs + native resources). No database.

## Development

### Prerequisites

- Go 1.23+
- minikube + Docker — `bunx kadai run minikube` to set up
- envtest binaries (for tests) — installed automatically by test scripts

### Local dev

```sh
# Set up k3s (one-time)
bunx kadai run minikube

# Start operator + API
bunx kadai run go-dev
```

### Running the operator alone

```sh
cd go
KUBECONFIG=/etc/rancher/k3s/k3s.yaml K8S_NAMESPACE=boilerhouse go run ./cmd/operator/
```

### Running the API alone

```sh
cd go
KUBECONFIG=/etc/rancher/k3s/k3s.yaml K8S_NAMESPACE=boilerhouse PORT=3000 go run ./cmd/api/
```

## Testing

```sh
# All tests (requires envtest binaries)
bunx kadai run go-unit

# Or manually
cd go
export KUBEBUILDER_ASSETS="$(setup-envtest use -p path)"
go test ./... -timeout 300s
```

### Test structure

```
go/internal/core/         workload parsing + validation tests
go/internal/operator/     controller tests (envtest-based)
go/internal/api/          API route tests (envtest + httptest)
go/internal/trigger/      trigger gateway tests
```

## Key directories

```
go/                   Go source (module: github.com/zdavison/boilerhouse/go)
  cmd/                entry points for 3 binaries
  internal/           private packages (core, operator, api, trigger, o11y, envoy)
  api/v1alpha1/       CRD type definitions (kubebuilder)
config/
  crd/bases/          CRD YAML (original from TS)
  crd/bases-go/       CRD YAML (generated from Go types)
  deploy/             kustomize deployment manifests
workloads/            example workload YAML definitions
scripts/              setup scripts (k3s)
docs/                 documentation and specs
```
