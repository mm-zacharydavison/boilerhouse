#!/bin/bash
# kadai:name E2E Tests
# kadai:emoji 🧪
# kadai:description Run E2E tests against a selected runtime (ensures infrastructure is ready)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

# ── Runtime selection ────────────────────────────────────────────────────────

echo "Select runtime for E2E tests:"
echo "  1) fake        — In-memory fake runtime (no infra needed)"
echo "  2) docker      — Container runtime via Docker daemon"
echo "  3) kubernetes  — Pods on minikube (boilerhouse-test profile)"
echo "  4) all         — All available runtimes"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|fake)       RUNTIMES="fake" ;;
  2|docker)     RUNTIMES="docker" ;;
  3|kubernetes) RUNTIMES="kubernetes" ;;
  4|all)        RUNTIMES="all" ;;
  *)
    echo "Invalid choice: $RUNTIME_CHOICE" >&2
    exit 1
    ;;
esac

echo ""

# ── Ensure runtime infrastructure ───────────────────────────────────────────

ensure_docker() {
  if ! docker info &>/dev/null; then
    echo "Error: Docker daemon is not running or not accessible." >&2
    echo "Hint: Start Docker Desktop or run: sudo systemctl start docker" >&2
    exit 1
  fi
  echo "✓ Docker daemon is running"
}

ensure_kubernetes() {
  local PROFILE="boilerhouse-test"
  local NAMESPACE="boilerhouse"

  # ── Minikube cluster ──────────────────────────────────────────────────
  if minikube status -p "$PROFILE" &>/dev/null; then
    echo "✓ Minikube cluster '$PROFILE' is running"
  else
    echo "Minikube cluster not running — starting..."
    bash "$SCRIPT_DIR/.kadai/actions/minikube.sh"
  fi

  if ! kubectl --context="$PROFILE" cluster-info &>/dev/null; then
    echo "Error: kubectl cannot reach minikube cluster" >&2
    return 1
  fi

  # ── Host-side dependencies (Redis) ────────────────────────────────────
  # The API runs on the host, so deps stay in docker-compose too.
  if ! curl -sf "http://localhost:6379" &>/dev/null 2>&1 && \
     ! nc -z localhost 6379 &>/dev/null 2>&1; then
    echo "Starting Redis via docker compose..."
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d redis
    sleep 2
  fi
  echo "✓ Redis is running on localhost:6379"

  # ── Start API server in background with kubernetes runtime ────────────
  local MINIKUBE_IP
  MINIKUBE_IP="$(minikube ip -p "$PROFILE")"
  local K8S_TOKEN
  K8S_TOKEN="$(kubectl --context="$PROFILE" -n "$NAMESPACE" create token default)"

  export RUNTIME_TYPE="kubernetes"
  export K8S_API_URL="https://${MINIKUBE_IP}:8443"
  export K8S_TOKEN="$K8S_TOKEN"
  export K8S_NAMESPACE="$NAMESPACE"
  export K8S_CONTEXT="$PROFILE"
  export K8S_MINIKUBE_PROFILE="$PROFILE"

  # Pick a random port to avoid conflicts
  local API_PORT
  API_PORT=$(( 10000 + RANDOM % 50000 ))

  echo "Starting API server on port $API_PORT (runtime=kubernetes)..."
  NODE_ENV=test PORT="$API_PORT" bun run "$SCRIPT_DIR/apps/api/src/server.ts" &
  API_PID=$!

  # Wait for API to be ready
  local retries=0
  while ! curl -sf "http://localhost:${API_PORT}/api/v1/health" &>/dev/null; do
    retries=$((retries + 1))
    if [ "$retries" -gt 30 ]; then
      echo "Error: API server did not start within 30s" >&2
      kill "$API_PID" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  echo "✓ API server ready at http://localhost:${API_PORT}"

  export BOILERHOUSE_K8S_API_URL="http://localhost:${API_PORT}"

  # Clean up API server on exit
  trap "kill $API_PID 2>/dev/null || true" EXIT
}

if [ "$RUNTIMES" = "docker" ] || [ "$RUNTIMES" = "all" ]; then
  ensure_docker
fi

if [ "$RUNTIMES" = "kubernetes" ] || [ "$RUNTIMES" = "all" ]; then
  ensure_kubernetes
fi

echo ""

# ── Run E2E tests ────────────────────────────────────────────────────────────
# For kubernetes, we run without exec so the EXIT trap can clean up the API
# server. For other runtimes, exec is fine (no background processes).

if [ "$RUNTIMES" = "all" ]; then
  echo "Running E2E tests against all available runtimes..."
  bun test tests/e2e/ --timeout 120000
elif [ "$RUNTIMES" = "kubernetes" ]; then
  echo "Running E2E tests against: kubernetes"
  BOILERHOUSE_E2E_RUNTIMES="kubernetes" bun test tests/e2e/ --timeout 120000
else
  echo "Running E2E tests against: $RUNTIMES"
  exec env BOILERHOUSE_E2E_RUNTIMES="$RUNTIMES" bun test tests/e2e/ --timeout 120000
fi
