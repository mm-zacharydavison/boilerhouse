#!/bin/bash
# kadai:name Go Dev
# kadai:emoji 🚀
# kadai:description Start the Go operator + API server against k3s

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OPERATOR_PID=""
API_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$OPERATOR_PID" ] && kill "$OPERATOR_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

# ── Ensure k3s is set up ────────────────────────────────────────────────────

if [ -f /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
elif command -v k3s &>/dev/null; then
  echo "k3s installed but KUBECONFIG not found. Run: bunx kadai run k3s"
  exit 1
else
  echo "k3s not installed. Run: bunx kadai run k3s"
  exit 1
fi

# Verify cluster is reachable
if ! kubectl get nodes &>/dev/null 2>&1; then
  echo "Cannot reach k3s cluster. Is it running?"
  echo "Run: bunx kadai run k3s"
  exit 1
fi

echo "k3s cluster ready (KUBECONFIG=$KUBECONFIG)"

# ── Apply CRDs ───────────────────────────────────────────────────────────────

echo "Applying CRDs..."
if [ -d "$SCRIPT_DIR/config/crd/bases-go" ]; then
  kubectl apply -f "$SCRIPT_DIR/config/crd/bases-go/" 2>/dev/null
elif [ -d "$SCRIPT_DIR/config/crd/bases" ]; then
  kubectl apply -f "$SCRIPT_DIR/config/crd/bases/" 2>/dev/null
fi
echo "CRDs applied"

# ── Start operator in background ─────────────────────────────────────────────

echo ""
echo "Starting operator..."
cd "$SCRIPT_DIR/go"
K8S_NAMESPACE=boilerhouse go run ./cmd/operator/ &
OPERATOR_PID=$!
echo "Operator running (PID $OPERATOR_PID)"

# Give operator a moment to start
sleep 2

# ── Start API in foreground ──────────────────────────────────────────────────

echo ""
echo "Starting API server on :3000..."
PORT=3000 LISTEN_HOST=127.0.0.1 K8S_NAMESPACE=boilerhouse exec go run ./cmd/api/
