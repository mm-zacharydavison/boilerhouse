#!/bin/bash
# kadai:name Dev
# kadai:emoji 🚀
# kadai:description Start operator + API server against minikube — Ctrl+C kills both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OPERATOR_PID=""
TRIGGER_PID=""
DASHBOARD_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$OPERATOR_PID" ] && kill "$OPERATOR_PID" 2>/dev/null || true
  [ -n "$TRIGGER_PID" ] && kill "$TRIGGER_PID" 2>/dev/null || true
  [ -n "$DASHBOARD_PID" ] && kill "$DASHBOARD_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

# ── Ensure minikube is set up ───────────────────────────────────────────────

PROFILE="boilerhouse"

if ! command -v minikube &>/dev/null; then
  echo "minikube not installed. Run: brew install minikube"
  exit 1
fi

if ! minikube status -p "$PROFILE" &>/dev/null 2>&1; then
  echo "minikube profile '$PROFILE' not running. Run: bunx kadai run minikube"
  exit 1
fi

kubectl config use-context "$PROFILE" &>/dev/null 2>&1 || true

# Verify cluster is reachable
if ! kubectl get nodes &>/dev/null 2>&1; then
  echo "Cannot reach minikube cluster. Run: bunx kadai run minikube"
  exit 1
fi

echo "minikube cluster ready (profile: $PROFILE)"

# ── Kill stale processes ────────────────────────────────────────────────────

for port in 3000 3001 8082 9465; do
  PID=$(lsof -i :"$port" -t 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "Killing stale process on port $port (PID $PID)"
    kill $PID 2>/dev/null || true
  fi
done
sleep 0.5

# ── Apply CRDs ───────────────────────────────────────────────────────────────

echo "Applying CRDs..."
if [ -d "$SCRIPT_DIR/config/crd/bases-go" ]; then
  kubectl apply -f "$SCRIPT_DIR/config/crd/bases-go/" 2>/dev/null
elif [ -d "$SCRIPT_DIR/config/crd/bases" ]; then
  kubectl apply -f "$SCRIPT_DIR/config/crd/bases/" 2>/dev/null
fi
echo "CRDs applied"

# ── Apply workloads ─────────────────────────────────────────────────────────

WORKLOADS_APPLY_DIR="${WORKLOADS_APPLY_DIR:-$SCRIPT_DIR/workloads}"
echo "Applying workloads from $WORKLOADS_APPLY_DIR..."
for f in "$WORKLOADS_APPLY_DIR"/*.yaml; do
  [ -e "$f" ] || continue  # no glob match
  kubectl apply -f "$f"
done
echo "Workloads applied"

# ── Start operator in background ─────────────────────────────────────────────

echo ""
echo "Starting operator..."
cd "$SCRIPT_DIR/go"
LEADER_ELECT=false HEALTH_PORT=8082 METRICS_PORT=9465 K8S_NAMESPACE=boilerhouse WORKLOADS_DIR="$SCRIPT_DIR/workloads" go run ./cmd/operator/ &
OPERATOR_PID=$!
echo "Operator running (PID $OPERATOR_PID)"

# Give operator a moment to start
sleep 2

# ── Build + deploy trigger gateway in-cluster ──────────────────────────────
#
# The trigger gateway must run inside the cluster: it dials pod IPs
# (e.g. 10.244.x.y) to forward events to workload containers, and those
# IPs are only routable from inside the K8s network.

echo ""
echo "Building boilerhouse-trigger image in minikube's docker..."
(
  eval "$(minikube -p "$PROFILE" docker-env)"
  cd "$SCRIPT_DIR/go"
  docker build -q -t boilerhouse-trigger:latest -f Dockerfile.trigger . >/dev/null
)
echo "Image built"

echo "Deploying trigger gateway..."
kubectl apply -f "$SCRIPT_DIR/config/deploy/trigger.yaml" >/dev/null
kubectl -n boilerhouse rollout restart deployment/boilerhouse-trigger >/dev/null
kubectl -n boilerhouse rollout status deployment/boilerhouse-trigger --timeout=60s

echo "Streaming trigger gateway logs..."
kubectl -n boilerhouse logs -f deployment/boilerhouse-trigger --prefix=false &
TRIGGER_PID=$!
echo "Trigger gateway log tail (PID $TRIGGER_PID)"

# ── Start dashboard in background ───────────────────────────────────────────

echo ""
echo "Starting dashboard on :3001..."
cd "$SCRIPT_DIR/ts/apps/dashboard"
bun --hot src/server.ts &
DASHBOARD_PID=$!
echo "Dashboard running (PID $DASHBOARD_PID)"

# ── Start API in foreground ──────────────────────────────────────────────────

echo ""
echo "Starting API server on :3000..."
cd "$SCRIPT_DIR/go"
PORT=3000 LISTEN_HOST=127.0.0.1 K8S_NAMESPACE=boilerhouse exec go run ./cmd/api/
