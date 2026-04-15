#!/bin/bash
# kadai:name Operator E2E Tests
# kadai:emoji ☸️
# kadai:description Run all Go tests (includes envtest-based controller tests)
# kadai:category tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$SCRIPT_DIR/go"

# ── Ensure envtest binaries are available ────────────────────────────────────

ENVTEST_ASSETS=""
if [ -d "/Users/z/Library/Application Support/io.kubebuilder.envtest" ]; then
  # Find the latest version
  ENVTEST_ASSETS="$(ls -d "/Users/z/Library/Application Support/io.kubebuilder.envtest/k8s/"* 2>/dev/null | sort -V | tail -1)"
fi

if [ -z "$ENVTEST_ASSETS" ]; then
  echo "Installing envtest binaries..."
  go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
  ENVTEST_ASSETS="$(setup-envtest use -p path 2>/dev/null || $(go env GOPATH)/bin/setup-envtest use -p path)"
fi

export KUBEBUILDER_ASSETS="$ENVTEST_ASSETS"
echo "KUBEBUILDER_ASSETS=$KUBEBUILDER_ASSETS"
echo ""

# ── Run tests ────────────────────────────────────────────────────────────────

echo "Running Go tests..."
exec go test ./... -timeout 300s -v
