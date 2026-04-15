#!/bin/bash
# kadai:name Setup
# kadai:emoji 📦
# kadai:description Install all dependencies (Go + TypeScript + dev tools)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Boilerhouse monorepo setup ==="
echo ""

# ── Go dependencies ──────────────────────────────────────────────────────────

echo "Installing Go dependencies..."
cd "$SCRIPT_DIR/go"
go mod download
echo "Go dependencies installed"

# ── envtest binaries (for Go controller tests) ──────────────────────────────

echo ""
echo "Installing envtest binaries..."
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
ENVTEST_PATH="$($(go env GOPATH)/bin/setup-envtest use -p path 2>/dev/null || setup-envtest use -p path 2>/dev/null)"
echo "envtest binaries at: $ENVTEST_PATH"

# ── controller-gen (for CRD generation) ──────────────────────────────────────

echo ""
echo "Installing controller-gen..."
go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest
echo "controller-gen installed"

# ── TypeScript dependencies ──────────────────────────────────────────────────

echo ""
echo "Installing TypeScript dependencies..."
cd "$SCRIPT_DIR/ts"
bun install
echo "TypeScript dependencies installed"

# ── Verify ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Setup complete ==="
echo ""
echo "  Go modules:     go/go.sum"
echo "  envtest:        $ENVTEST_PATH"
echo "  TS node_modules: ts/node_modules/"
echo ""
echo "Next steps:"
echo "  bunx kadai run k3s          # set up local k3s cluster"
echo "  bunx kadai run dev          # start operator + API + dashboard"
echo "  bunx kadai run e2e-operator # run tests"
