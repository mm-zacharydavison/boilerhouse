#!/bin/bash
# kadai:name Operator E2E Tests
# kadai:emoji ☸️
# kadai:description Run E2E tests against the K8s operator on minikube
# kadai:category tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
PROFILE="boilerhouse-test"

# ── Ensure minikube is ready ────────────────────────────────────────────────

if ! minikube status -p "$PROFILE" &>/dev/null; then
  echo "Minikube cluster not running — starting..."
  bash "$SCRIPT_DIR/.kadai/actions/minikube.sh"
else
  echo "✓ Minikube cluster '$PROFILE' is running"

  # Ensure CRDs and RBAC are applied even if cluster was already running
  kubectl --context="$PROFILE" apply -f "$SCRIPT_DIR/apps/operator/crds/" --quiet
  kubectl --context="$PROFILE" apply -f "$SCRIPT_DIR/apps/operator/deploy/rbac.yaml" --quiet
  echo "✓ CRDs and RBAC applied"
fi

# ── Run tests ───────────────────────────────────────────────────────────────
# The test preload script (setup.ts) handles starting/stopping the operator.

echo ""
echo "Running operator E2E tests..."
exec bun test tests/e2e-operator/ --preload ./tests/e2e-operator/setup.ts --timeout 120000
