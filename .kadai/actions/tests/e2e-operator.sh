#!/bin/bash
# kadai:name Operator E2E Tests
# kadai:emoji ☸️
# kadai:description Run E2E tests against the Go operator on minikube
# kadai:category tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$SCRIPT_DIR/go"

# ── Verify minikube is running ──────────────────────────────────────────────

PROFILE="boilerhouse"

if ! minikube status -p "$PROFILE" &>/dev/null 2>&1; then
  echo "minikube profile '$PROFILE' not running."
  echo "Start it with: bunx kadai run minikube"
  exit 1
fi

echo "minikube cluster '$PROFILE' is running"
kubectl config use-context "$PROFILE" &>/dev/null 2>&1 || true

# ── Run E2E tests ───────────────────────────────────────────────────────────
# The tests build and start the operator themselves (see main_test.go).

echo ""
echo "Running operator E2E tests..."
exec go test -tags e2e -v -timeout 600s ./tests/e2e/
