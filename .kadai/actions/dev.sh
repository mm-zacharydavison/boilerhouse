#!/bin/bash
# kadai:name Dev
# kadai:emoji 🚀
# kadai:description Start dashboard (background) + API (foreground) — Ctrl+C kills both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DASHBOARD_PID=""

cleanup() {
  if [ -n "$DASHBOARD_PID" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
    wait "$DASHBOARD_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

# ── Runtime selection ────────────────────────────────────────────────────────

IS_MACOS=false
if [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
fi

echo "Select runtime:"
echo "  1) podman   — Container runtime via boilerhouse-podmand"
echo "  2) kubernetes — Pods on minikube (boilerhouse-test profile)"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|podman)   RUNTIME_TYPE="podman" ;;
  2|kubernetes) RUNTIME_TYPE="kubernetes" ;;
  *)
    echo "Invalid choice: $RUNTIME_CHOICE" >&2
    exit 1
    ;;
esac

echo ""
echo "Using runtime: $RUNTIME_TYPE"
echo ""

# ── Ensure runtime infrastructure ───────────────────────────────────────────

if [ "$RUNTIME_TYPE" = "podman" ]; then
  # Resolve socket path
  if [ "$IS_MACOS" = true ]; then
    RUNTIME_SOCKET="${LISTEN_SOCKET:-$HOME/.local/share/boilerhouse/runtime.sock}"
  else
    RUNTIME_SOCKET="${LISTEN_SOCKET:-/var/run/boilerhouse/runtime.sock}"
  fi

  # Check if daemon is already running
  if [ -S "$RUNTIME_SOCKET" ]; then
    # Verify it's responsive
    PING_OK=false
    if curl --unix-socket "$RUNTIME_SOCKET" --max-time 2 -sf http://localhost/_ping &>/dev/null; then
      PING_OK=true
    fi

    if [ "$PING_OK" = true ]; then
      echo "✓ Podman daemon already running ($RUNTIME_SOCKET)"
    else
      echo "Stale daemon socket found — restarting..."
      bash "$SCRIPT_DIR/.kadai/actions/daemon.sh"
    fi
  else
    echo "Podman daemon not running — starting..."
    bash "$SCRIPT_DIR/.kadai/actions/daemon.sh"
  fi

  echo ""

elif [ "$RUNTIME_TYPE" = "kubernetes" ]; then
  PROFILE="boilerhouse-test"
  NAMESPACE="boilerhouse"

  # Ensure minikube cluster is running
  if minikube status -p "$PROFILE" &>/dev/null; then
    echo "✓ Minikube cluster '$PROFILE' is running"
  else
    echo "Minikube cluster not running — starting..."
    bash "$SCRIPT_DIR/.kadai/actions/minikube.sh"
  fi

  # Verify kubectl can reach the cluster
  if ! kubectl --context="$PROFILE" cluster-info &>/dev/null; then
    echo "Error: kubectl cannot reach minikube cluster" >&2
    exit 1
  fi

  MINIKUBE_IP="$(minikube ip -p "$PROFILE")"
  K8S_TOKEN="$(kubectl --context="$PROFILE" -n "$NAMESPACE" create token default)"

  export K8S_API_URL="https://${MINIKUBE_IP}:8443"
  export K8S_TOKEN="$K8S_TOKEN"
  export K8S_NAMESPACE="$NAMESPACE"
  export K8S_CONTEXT="$PROFILE"
  export K8S_MINIKUBE_PROFILE="$PROFILE"

  echo "  API server: ${MINIKUBE_IP}:8443"
  echo ""
fi

# ── Kill stale dev processes ─────────────────────────────────────────────────

STALE_PIDS=""
for port in 3000 3001 18080; do
  PID=$(lsof -i :"$port" -t 2>/dev/null || true)
  if [ -n "$PID" ]; then
    STALE_PIDS="$STALE_PIDS $PID"
  fi
done
# Deduplicate and kill all at once, then wait
STALE_PIDS=$(echo "$STALE_PIDS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
if [ -n "${STALE_PIDS// }" ]; then
  echo "Killing stale processes: $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true
  sleep 1
  # Force-kill any survivors
  for pid in $STALE_PIDS; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.3
fi

# ── Start dashboard + API ────────────────────────────────────────────────────

# Start dashboard in background
echo "Starting dashboard..."
cd "$SCRIPT_DIR/apps/dashboard"
bun --hot src/server.ts &
DASHBOARD_PID=$!
echo "Dashboard running (PID $DASHBOARD_PID)"

# Start API in foreground with runtime env vars
echo ""
echo "Starting API (RUNTIME_TYPE=$RUNTIME_TYPE)..."
cd "$SCRIPT_DIR/apps/api"
export RUNTIME_TYPE="$RUNTIME_TYPE"
exec bun --hot src/server.ts
