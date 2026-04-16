#!/bin/bash
# kadai:name Nuke
# kadai:emoji 💣
# kadai:description Delete all Boilerhouse resources from the cluster (workloads, pools, claims, triggers, pods, pvcs)

set -euo pipefail

PROFILE="boilerhouse"
NAMESPACE="boilerhouse"

if ! kubectl config use-context "$PROFILE" &>/dev/null 2>&1; then
  echo "Cannot switch to context '$PROFILE'. Is minikube running?"
  exit 1
fi

echo "Nuking all Boilerhouse resources in namespace '$NAMESPACE'..."
echo ""

# Delete in dependency order: claims first (releases pods), then pools, then workloads.
# Strip finalizers from stuck resources to avoid hangs.

for crd in boilerhouseclaims boilerhousepools boilerhousetriggers boilerhouseworkloads; do
  echo "Deleting $crd..."
  # Strip finalizers first to avoid stuck deletions
  kubectl -n "$NAMESPACE" get "$crd" -o name 2>/dev/null | while read -r name; do
    kubectl -n "$NAMESPACE" patch "$name" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
  done
  kubectl -n "$NAMESPACE" delete "$crd" --all --timeout=15s 2>/dev/null || true
done

echo ""
echo "Deleting managed pods..."
kubectl -n "$NAMESPACE" delete pods -l boilerhouse.dev/managed=true --grace-period=0 --force --timeout=15s 2>/dev/null || true

echo "Deleting snapshot helper pod..."
kubectl -n "$NAMESPACE" delete pod boilerhouse-snapshot-helper --grace-period=0 --force --timeout=10s 2>/dev/null || true

echo "Deleting PVCs..."
kubectl -n "$NAMESPACE" delete pvc --all --timeout=15s 2>/dev/null || true

echo "Deleting services..."
kubectl -n "$NAMESPACE" delete svc -l boilerhouse.dev/managed=true --timeout=10s 2>/dev/null || true

echo "Deleting configmaps..."
kubectl -n "$NAMESPACE" delete configmap -l boilerhouse.dev/managed=true --timeout=10s 2>/dev/null || true

echo "Deleting network policies..."
kubectl -n "$NAMESPACE" delete networkpolicy -l boilerhouse.dev/managed=true --timeout=10s 2>/dev/null || true

echo ""
echo "Done. Cluster is clean."
kubectl -n "$NAMESPACE" get all 2>/dev/null || true
