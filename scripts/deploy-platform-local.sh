#!/usr/bin/env bash
# Local Kubernetes demo path: build the images, load them into k3d, and deploy the platform
# itself with Helm (API + dashboard + PostgreSQL + ServiceAccount/RBAC).
#
# This is the canonical local demo: the platform runs INSIDE Kubernetes, so provisioning
# happens with the platform's own ServiceAccount rather than an admin kubeconfig.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

CLUSTER_NAME="${CLUSTER_NAME:-urumi}"
RELEASE="${RELEASE:-urumi}"
NAMESPACE="${NAMESPACE:-urumi-system}"
IMAGE_TAG="${IMAGE_TAG:-local}"

for cmd in k3d kubectl helm docker; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed."
    exit 1
  fi
done

echo "==> Ensuring k3d cluster '$CLUSTER_NAME' exists..."
if k3d cluster list | grep -q "^${CLUSTER_NAME}"; then
  echo "    cluster already exists"
else
  "$SCRIPT_DIR/k3d-setup.sh"
fi
kubectl config use-context "k3d-${CLUSTER_NAME}" >/dev/null

# Path A needs roughly 5 GB: k3s base, ingress-nginx, the two platform images and the store images
# (WordPress + MariaDB) that get pulled by the first store. Check before, not after.
available_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "==> Free disk space: ${available_gb} GB"
if [ "${available_gb:-0}" -lt 3 ]; then
  echo "ERROR: at least 3 GB free is required (found ${available_gb} GB)."
  echo "       Free space first, e.g. docker system prune -af && rm -rf ~/.cache/<large-cache>"
  exit 1
fi
if [ "${available_gb:-0}" -lt 6 ]; then
  echo "    WARNING: tight on disk. Image pulls for the first store will consume several GB;"
  echo "             monitor with 'df -h /' and prune with 'docker builder prune -f' if needed."
fi

echo "==> Building images..."
docker build -f api/Dockerfile       -t "urumi-api:${IMAGE_TAG}"       .
docker build -f dashboard/Dockerfile -t "urumi-dashboard:${IMAGE_TAG}" .

echo "==> Importing images into k3d (local images are not in any registry)..."
k3d image import "urumi-api:${IMAGE_TAG}" "urumi-dashboard:${IMAGE_TAG}" -c "$CLUSTER_NAME"

# Intermediate build layers are no longer needed once the images are built and imported.
# On a small disk this is the difference between fitting the first store and filling the volume.
echo "==> Reclaiming build cache..."
docker builder prune -f > /dev/null 2>&1 || true
echo "    free disk space now: $(df -BG --output=avail / | tail -1 | tr -dc '0-9') GB"

echo "==> Ensuring platform database credentials exist..."
# The chart deliberately renders no Secret: credentials are created here (or by an external secret
# manager in production) so that no password is committed in values or stored in the Helm release.
# Re-running is safe - an existing Secret is never overwritten, so the database stays reachable.
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - > /dev/null
if kubectl -n "$NAMESPACE" get secret urumi-postgres > /dev/null 2>&1; then
  echo "    platform DB secret already present (leaving credentials untouched)"
else
  DB_PASSWORD="$(openssl rand -hex 24)"
  kubectl -n "$NAMESPACE" create secret generic urumi-postgres \
    --from-literal=postgres-password="$DB_PASSWORD" \
    --from-literal=password="$DB_PASSWORD" \
    --from-literal=username=urumi \
    --from-literal=database=urumi \
    --from-literal=DATABASE_URL="postgresql://urumi:${DB_PASSWORD}@${RELEASE}-postgresql:5432/urumi" > /dev/null
  echo "    generated a fresh random password and stored it in Secret urumi-postgres"
fi

echo "==> Building chart dependencies..."
helm dependency build helm/platform

echo "==> Deploying the platform..."
helm upgrade --install "$RELEASE" ./helm/platform \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f helm/platform/values-local.yaml \
  --set "api.image.tag=${IMAGE_TAG}" \
  --set "dashboard.image.tag=${IMAGE_TAG}" \
  --wait --timeout 10m

echo ""
echo "==> Platform deployed."
kubectl -n "$NAMESPACE" get deploy,svc,sa
echo ""
echo "Dashboard:  http://${RELEASE}.localtest.me/            (or kubectl -n ${NAMESPACE} port-forward svc/${RELEASE}-platform-dashboard 8080:8080)"
echo "API health: http://${RELEASE}.localtest.me/api/health"
echo "API logs:   kubectl -n ${NAMESPACE} logs deploy/${RELEASE}-platform-api -f"
echo ""
echo "Store namespaces are created by the platform, with the platform ServiceAccount:"
echo "  kubectl auth can-i create namespaces --as=system:serviceaccount:${NAMESPACE}:${RELEASE}-platform-api"
echo ""
echo "Disk after deploy: $(df -BG --output=avail / | tail -1 | tr -dc '0-9') GB free"
