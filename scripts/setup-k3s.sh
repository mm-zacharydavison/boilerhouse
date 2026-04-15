#!/usr/bin/env bash
set -euo pipefail

echo "Installing k3s (minimal configuration)..."
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
  --disable traefik \
  --disable servicelb \
  --disable metrics-server \
  --disable local-storage \
  --write-kubeconfig-mode 644" sh -

echo "Waiting for k3s to be ready..."
until kubectl get nodes &>/dev/null; do
  sleep 2
done

echo "Creating boilerhouse namespace..."
kubectl create namespace boilerhouse --dry-run=client -o yaml | kubectl apply -f -

echo "Applying CRDs..."
kubectl apply -f config/crd/bases/

echo "k3s setup complete."
echo "KUBECONFIG is at /etc/rancher/k3s/k3s.yaml"
