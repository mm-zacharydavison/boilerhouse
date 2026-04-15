#!/bin/bash
# kadai:name k3s
# kadai:emoji ☸️
# kadai:description Start/setup k3s for local Go development

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NAMESPACE="boilerhouse"

# ── Check for k3s ────────────────────────────────────────────────────────────

if ! command -v k3s &>/dev/null; then
  echo "k3s not found — installing..."
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
    --disable traefik \
    --disable servicelb \
    --disable metrics-server \
    --disable local-storage \
    --write-kubeconfig-mode 644" sh -
else
  echo "k3s already installed"
  # Check if running
  if sudo k3s kubectl get nodes &>/dev/null 2>&1; then
    echo "k3s is running"
  else
    echo "Starting k3s..."
    sudo systemctl start k3s 2>/dev/null || sudo k3s server --disable traefik --disable servicelb --disable metrics-server --disable local-storage &
    echo "Waiting for k3s to be ready..."
    until sudo k3s kubectl get nodes &>/dev/null 2>&1; do
      sleep 2
    done
  fi
fi

# ── Set KUBECONFIG ───────────────────────────────────────────────────────────

if [ -f /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  echo "KUBECONFIG=$KUBECONFIG"
fi

# ── Namespace ────────────────────────────────────────────────────────────────

kubectl get namespace "$NAMESPACE" &>/dev/null 2>&1 \
  || kubectl create namespace "$NAMESPACE"
echo "Namespace '$NAMESPACE' ready"

# ── Apply CRDs ───────────────────────────────────────────────────────────────

echo "Applying CRDs..."
if [ -d "$SCRIPT_DIR/config/crd/bases-go" ]; then
  kubectl apply -f "$SCRIPT_DIR/config/crd/bases-go/"
elif [ -d "$SCRIPT_DIR/config/crd/bases" ]; then
  kubectl apply -f "$SCRIPT_DIR/config/crd/bases/"
fi

# ── RBAC ─────────────────────────────────────────────────────────────────────

echo "Applying RBAC..."
kubectl apply -f "$SCRIPT_DIR/config/deploy/operator.yaml"

echo ""
echo "k3s ready for Boilerhouse development"
echo "  KUBECONFIG: ${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
echo "  Namespace:  $NAMESPACE"
echo ""
echo "Start the operator:  cd go && go run ./cmd/operator/"
echo "Start the API:       cd go && go run ./cmd/api/"
