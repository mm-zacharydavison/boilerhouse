#!/bin/bash
# kadai:name minikube
# kadai:emoji ☸️
# kadai:description Set up local K8s cluster (minikube)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NAMESPACE="boilerhouse"
PROFILE="boilerhouse"

# ── Minikube ─────────────────────────────────────────────────────────────────

if ! command -v minikube &>/dev/null; then
  echo "minikube not found — install it:"
  echo "  macOS:  brew install minikube"
  echo "  Linux:  curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64 && sudo install minikube-linux-amd64 /usr/local/bin/minikube"
  exit 1
fi

if minikube status -p "$PROFILE" &>/dev/null 2>&1; then
  echo "minikube profile '$PROFILE' is running"
else
  echo "Starting minikube profile '$PROFILE'..."
  minikube start -p "$PROFILE" --driver=docker --cpus=4 --memory=4096
fi

# Ensure kubectl uses the minikube context
kubectl config use-context "$PROFILE" &>/dev/null 2>&1 || true

# ── Namespace ────────────────────────────────────────────────────────────────

kubectl get namespace "$NAMESPACE" &>/dev/null 2>&1 \
  || kubectl create namespace "$NAMESPACE"
echo "Namespace '$NAMESPACE' ready"

# ── Apply CRDs ───────────────────────────────────────────────────────────────

echo "Applying CRDs..."
kubectl apply -f "$SCRIPT_DIR/config/crd/bases-go/"

# ── RBAC ─────────────────────────────────────────────────────────────────────

echo "Applying RBAC..."
kubectl apply -f "$SCRIPT_DIR/config/deploy/operator.yaml"

echo ""
echo "Local K8s ready for Boilerhouse development"
echo "  Namespace:  $NAMESPACE"
echo ""
echo "Start the operator:  cd go && go run ./cmd/operator/"
echo "Start the API:       cd go && go run ./cmd/api/"
