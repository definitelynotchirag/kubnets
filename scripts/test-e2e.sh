#!/usr/bin/env bash
# Infrastructure E2E test: create -> provision -> verify Kubernetes objects -> storefront
# responds -> delete -> namespace really gone.
#
# The WooCommerce application flow (add to cart -> checkout -> COD -> order visible in wp-admin)
# is a separate, manual demo — see README ("Application checkout walkthrough").
#
# Env:
#   API_URL        API base URL                      (default http://localhost:3001)
#   STORE_DOMAIN   store hostname suffix             (default localtest.me)
#   KEEP_STORE     set to 1 to skip deletion at the end
#
# The namespace/PVC/secret/release assertions are the point of this test, so they are never
# skipped: cluster access is resolved by scripts/lib/kube.sh (host kubectl/helm when available,
# otherwise `docker compose exec` into the k3s/api containers).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/kube.sh
source "$SCRIPT_DIR/lib/kube.sh"

API_URL="${API_URL:-http://localhost:3001}"
STORE_DOMAIN="${STORE_DOMAIN:-localtest.me}"
KEEP_STORE="${KEEP_STORE:-0}"
POLL_INTERVAL=10
MAX_POLLS=60

need() { command -v "$1" &>/dev/null || { echo "ERROR: $1 is required"; exit 1; }; }
need curl
need jq

fail() { echo "==> FAILED: $*"; exit 1; }

# Cluster reads can fail transiently (API server briefly unavailable, list timing out). Retry a
# few times and surface the real output on failure: an empty result must not be reported as
# "resource missing" when the actual problem was a transient read error.
kube_out() {
  local out=""
  for _ in 1 2 3 4 5; do
    out=$(kube "$@" 2>&1) || true
    [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    sleep 2
  done
  printf '%s' "$out"
  return 1
}

echo "==> E2E: create, verify, delete a WooCommerce store"

RESPONSE=$(curl -s -X POST "$API_URL/api/stores" -H "Content-Type: application/json" -d '{"engine":"woocommerce"}')
STORE_ID=$(echo "$RESPONSE" | jq -r '.store.id // empty')
NAMESPACE=$(echo "$RESPONSE" | jq -r '.store.namespace // empty')
[ -n "$STORE_ID" ] || fail "store creation returned no id: $RESPONSE"
echo "    store id:  $STORE_ID"
echo "    namespace: $NAMESPACE"

echo "==> Waiting for Ready (create -> provisioning -> Ready)..."
STATUS=""
for i in $(seq 1 "$MAX_POLLS"); do
  STORE=$(curl -s "$API_URL/api/stores/$STORE_ID")
  STATUS=$(echo "$STORE" | jq -r '.store.status')
  echo "    poll $i/$MAX_POLLS: $STATUS"
  case "$STATUS" in
    Ready)  break ;;
    Failed) echo "$STORE" | jq -r '.store.errorMessage'; fail "store provisioning failed" ;;
  esac
  sleep "$POLL_INTERVAL"
done
[ "$STATUS" = "Ready" ] || fail "timed out waiting for Ready"

STORE_URL=$(curl -s "$API_URL/api/stores/$STORE_ID" | jq -r '.store.url')
echo "==> Store reports Ready: $STORE_URL"

echo "==> Verifying Kubernetes objects"
kube_out get namespace "$NAMESPACE" >/dev/null || fail "namespace $NAMESPACE does not exist"
echo "    namespace:      present"

pods=$(kube_out get pods -n "$NAMESPACE" --no-headers)
grep -q "Running\|Completed" <<<"$pods" || fail "no running pods in $NAMESPACE (got: $(head -2 <<<"$pods" | tr '\n' ' '))"
echo "    pods:           $(wc -l <<<"$pods") present"

pvcs=$(kube_out get pvc -n "$NAMESPACE" --no-headers)
grep -q "Bound" <<<"$pvcs" || fail "no bound PVC in $NAMESPACE (got: $(head -2 <<<"$pvcs" | tr '\n' ' '))"
echo "    PVCs:           $(grep -c Bound <<<"$pvcs") bound"

kube_out get secret -n "$NAMESPACE" store-credentials >/dev/null || fail "store-credentials secret missing"
echo "    credentials:    store-credentials present"

policies=$(kube_out get networkpolicy -n "$NAMESPACE" --no-headers)
grep -q "default-deny-ingress" <<<"$policies" || fail "default-deny-ingress policy missing"
echo "    networkpolicy:  $(wc -l <<<"$policies") policies (default-deny present)"

helmk status "$NAMESPACE" --namespace "$NAMESPACE" >/dev/null || fail "Helm release $NAMESPACE missing"
echo "    helm release:   deployed"

# The init Job is what makes the store usable; a missing/unsuccessful one means no demo product.
job=$(kube_out get job "$NAMESPACE-woocommerce-init" -n "$NAMESPACE" --no-headers)
grep -q "$NAMESPACE-woocommerce-init" <<<"$job" || fail "woocommerce init job missing (got: $(head -1 <<<"$job"))"
echo "    init job:       $(awk '{print $2}' <<<"$job") succeeded"

echo "==> Storefront HTTP check: $STORE_URL"
HTTP_CODE=$(curl -s -o /tmp/urumi-storefront.html -w "%{http_code}" "$STORE_URL" --max-time 15 || echo "000")
echo "    HTTP $HTTP_CODE"
[ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 400 ] || fail "storefront returned $HTTP_CODE"

# The assignment requires a usable storefront, not just a running pod: the seeded product has to
# be reachable. /shop/ is created by the init Job; the query-string form is the fallback when
# permalinks are still plain.
echo "==> Verifying the seeded product is on the storefront"
product_html=""
product_source=""
for path in "/shop/" "/?post_type=product"; do
  code=$(curl -s -o /tmp/urumi-product.html -w "%{http_code}" "${STORE_URL}${path}" --max-time 15 || echo "000")
  if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
    product_html=$(cat /tmp/urumi-product.html)
    product_source="$path"
    break
  fi
done
[ -n "$product_html" ] || fail "neither /shop/ nor /?post_type=product is reachable on $STORE_URL"
echo "$product_html" | grep -qi "demo product\|demo-product" \
  || fail "seeded demo product not found at $product_source (check: $KUBECTL logs -n $NAMESPACE job/$NAMESPACE-woocommerce-init)"
echo "    demo product:   visible at $product_source"

if [ "$KEEP_STORE" = "1" ]; then
  echo "==> KEEP_STORE=1: leaving store $STORE_ID ($NAMESPACE) running"
  echo "==> E2E (infrastructure) completed"
  exit 0
fi

echo "==> Deleting store"
curl -s -X DELETE "$API_URL/api/stores/$STORE_ID" >/dev/null
for i in $(seq 1 "$MAX_POLLS"); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/stores/$STORE_ID")
  if [ "$CODE" = "404" ]; then
    echo "    store record removed"
    break
  fi
  echo "    poll $i/$MAX_POLLS: still deleting..."
  sleep "$POLL_INTERVAL"
done
[ "$CODE" = "404" ] || fail "store record still present after deletion"

if kube get namespace "$NAMESPACE" &>/dev/null; then
  fail "namespace $NAMESPACE still exists after deletion"
fi
echo "    namespace gone"

echo ""
echo "==> E2E (infrastructure) completed"
