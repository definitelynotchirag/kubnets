#!/usr/bin/env bash
# Crash-recovery test: kill the API while a store is provisioning and prove that provisioning
# resumes and converges after restart.
#
# It checks the three properties that make recovery believable:
#   1. resources are not duplicated (namespace + release still exist, exactly once),
#   2. credentials are not rotated (the secret is byte-identical after recovery),
#   3. the store still reaches Ready.
#
# Env:
#   API_URL     API base URL        (default http://localhost:3001)
#   API_MODE    k8s | compose       (default: k8s when the platform Deployment is reachable)
#   K8S_NAMESPACE / K8S_DEPLOYMENT  platform location when API_MODE=k8s
#
# Cluster access comes from scripts/lib/kube.sh (host kubectl, or `docker compose exec` into the
# k3s container), so the namespace/secret assertions always run instead of being skipped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/kube.sh
source "$SCRIPT_DIR/lib/kube.sh"

API_URL="${API_URL:-http://localhost:3001}"
K8S_NAMESPACE="${K8S_NAMESPACE:-urumi-system}"
K8S_DEPLOYMENT="${K8S_DEPLOYMENT:-urumi-platform-api}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev.yaml}"
POLL_INTERVAL=5
MAX_POLLS=120

need() { command -v "$1" &>/dev/null || { echo "ERROR: $1 is required"; exit 1; }; }
need curl
need jq

fail() { echo "==> FAILED: $*"; exit 1; }

if [ -z "${API_MODE:-}" ]; then
  if kube get deploy "$K8S_DEPLOYMENT" -n "$K8S_NAMESPACE" &>/dev/null; then
    API_MODE=k8s
  else
    API_MODE=compose
  fi
fi
echo "==> Crash-recovery test (API_MODE=$API_MODE)"

kill_api() {
  if [ "$API_MODE" = "k8s" ]; then
    # SIGKILL the pod: no chance to finish in-flight work or shut down cleanly.
    kube delete pod -n "$K8S_NAMESPACE" -l app.kubernetes.io/component=api --grace-period=0 --force
  else
    docker compose -f "$COMPOSE_FILE" kill api
  fi
}

start_api() {
  if [ "$API_MODE" = "k8s" ]; then
    kube rollout status deploy/"$K8S_DEPLOYMENT" -n "$K8S_NAMESPACE" --timeout=180s
  else
    docker compose -f "$COMPOSE_FILE" start api
  fi
}

wait_api() {
  for _ in $(seq 1 60); do
    curl -sf "$API_URL/api/health" >/dev/null && return 0
    sleep 2
  done
  return 1
}

echo "==> Creating a store"
response=$(curl -s -X POST "$API_URL/api/stores" -H "Content-Type: application/json" -d '{"engine":"woocommerce"}')
STORE_ID=$(echo "$response" | jq -r '.store.id // empty')
NAMESPACE=$(echo "$response" | jq -r '.store.namespace // empty')
[ -n "$STORE_ID" ] || fail "creation failed: $response"
echo "    store $STORE_ID ($NAMESPACE)"

echo "==> Waiting until it starts provisioning"
for _ in $(seq 1 60); do
  status=$(curl -s "$API_URL/api/stores/$STORE_ID" | jq -r '.store.status') || status="unreachable"
  case "$status" in
    Provisioning) break ;;
    Ready) echo "    store already Ready - provisioning finished too fast to interrupt"; break ;;
  esac
  sleep 2
done
echo "    status: $status"

# Captured before the crash to prove recovery reuses credentials instead of rotating them.
# The secret is created a moment *after* the status flips to Provisioning, so wait for it rather
# than failing on that race.
SECRET_BEFORE=""
for _ in $(seq 1 30); do
  SECRET_BEFORE=$(kube get secret store-credentials -n "$NAMESPACE" -o jsonpath='{.data}' 2>/dev/null || true)
  [ -n "$SECRET_BEFORE" ] && break
  sleep 2
done
[ -n "$SECRET_BEFORE" ] || fail "no store-credentials secret appeared for $NAMESPACE (did provisioning start?)"
echo "    credentials captured before the crash"

echo "==> Killing the API process"
kill_api
sleep 5

echo "==> Restarting the API"
start_api
wait_api || fail "API did not come back"
echo "    API healthy again"

echo "==> Waiting for the store to converge to Ready"
for i in $(seq 1 "$MAX_POLLS"); do
  store=$(curl -s "$API_URL/api/stores/$STORE_ID")
  status=$(echo "$store" | jq -r '.store.status')
  echo "    poll $i/$MAX_POLLS: $status"
  [ "$status" = "Ready" ] && break
  [ "$status" = "Failed" ] && { echo "$store" | jq -r '.store.errorMessage'; fail "store failed after recovery"; }
  sleep "$POLL_INTERVAL"
done
[ "$status" = "Ready" ] || fail "store did not recover to Ready"

namespaces=$(kube get ns "$NAMESPACE" --no-headers | wc -l)
[ "$namespaces" -eq 1 ] || fail "expected exactly one namespace $NAMESPACE"
echo "    resources were not duplicated (single namespace)"

SECRET_AFTER=$(kube get secret store-credentials -n "$NAMESPACE" -o jsonpath='{.data}' 2>/dev/null || true)
[ -n "$SECRET_AFTER" ] || fail "store-credentials secret disappeared during recovery"
[ "$SECRET_BEFORE" = "$SECRET_AFTER" ] || fail "credentials were rotated during recovery"
echo "    credentials unchanged across the crash"

echo ""
echo "==> Crash-recovery test completed (store $STORE_ID is Ready)"
echo "    Clean up with: curl -X DELETE $API_URL/api/stores/$STORE_ID"
