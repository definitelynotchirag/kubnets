#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="urumi"
# Host ports the k3d load balancer binds. Override when something else already owns 80/443
# (e.g. a pre-existing nginx on a VPS): HTTP_PORT=8080 HTTPS_PORT=8443 ./scripts/k3d-setup.sh
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"

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
    --port "${HTTP_PORT}:80@loadbalancer" \
    --port "${HTTPS_PORT}:443@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
    --wait
fi

echo "==> Waiting for the API server to answer..."
# Right after cluster creation the API server is still warming up and answers
# "ServiceUnavailable"; a bare `kubectl wait` here fails the whole setup on slow machines.
for i in $(seq 1 30); do
  if kubectl get nodes &>/dev/null; then break; fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: the API server did not become reachable within 60s"
    exit 1
  fi
  sleep 2
done

echo "==> Waiting for cluster to be ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=180s

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
