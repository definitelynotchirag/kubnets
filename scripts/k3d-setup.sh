#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="urumi"

echo "==> Checking prerequisites..."
for cmd in k3d kubectl helm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed."
    exit 1
  fi
done

# Check if cluster already exists
if k3d cluster list | grep -q "$CLUSTER_NAME"; then
  echo "==> Cluster '$CLUSTER_NAME' already exists. Skipping creation."
else
  echo "==> Creating k3d cluster '$CLUSTER_NAME'..."
  k3d cluster create "$CLUSTER_NAME" \
    --port "80:80@loadbalancer" \
    --port "443:443@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
    --wait
fi

echo "==> Waiting for cluster to be ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=60s

# Install nginx ingress controller if not present
if ! kubectl get namespace ingress-nginx &>/dev/null; then
  echo "==> Installing nginx ingress controller..."
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/cloud/deploy.yaml

  echo "==> Waiting for ingress controller to be ready..."
  kubectl wait --namespace ingress-nginx \
    --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller \
    --timeout=120s
else
  echo "==> Nginx ingress controller already installed."
fi

echo "==> Cluster '$CLUSTER_NAME' is ready!"
kubectl cluster-info
