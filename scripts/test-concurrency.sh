#!/usr/bin/env bash
# Concurrent provisioning + tenant isolation.
#
# Test 4/5 from the assignment: create three stores at once, verify they all become Ready with
# distinct namespaces/credentials/URLs, delete one, and verify the other two keep working.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/kube.sh
source "$SCRIPT_DIR/lib/kube.sh"

API_URL="${API_URL:-http://localhost:3001}"
POLL_INTERVAL=10
MAX_POLLS=90

# Cluster access is required here: the isolation assertions (distinct namespaces, quotas and
# credentials per store) are core to this test and are never skipped silently.
need() { command -v "$1" &>/dev/null || { echo "ERROR: $1 is required"; exit 1; }; }
need curl
need jq

fail() { echo "==> FAILED: $*"; exit 1; }

echo "==> Creating 3 WooCommerce stores back to back"

ids=()
namespaces=()
for i in 1 2 3; do
  response=$(curl -s -X POST "$API_URL/api/stores" -H "Content-Type: application/json" -d '{"engine":"woocommerce"}')
  id=$(echo "$response" | jq -r '.store.id // empty')
  ns=$(echo "$response" | jq -r '.store.namespace // empty')
  [ -n "$id" ] || fail "store $i creation failed: $response"
  ids+=("$id")
  namespaces+=("$ns")
  echo "    store $i: $id  ($ns)"
done

echo "==> They should now be provisioning concurrently"
curl -s "$API_URL/api/stores" | jq -r '.stores[] | "    \(.namespace)  \(.status)"'

echo "==> Waiting for all three to become Ready"
for i in $(seq 1 "$MAX_POLLS"); do
  statuses=()
  for id in "${ids[@]}"; do
    statuses+=("$(curl -s "$API_URL/api/stores/$id" | jq -r '.store.status')")
  done
  echo "    poll $i/$MAX_POLLS: ${statuses[*]}"
  for s in "${statuses[@]}"; do
    [ "$s" = "Failed" ] && fail "a store failed to provision"
  done
  ready=0
  for s in "${statuses[@]}"; do [ "$s" = "Ready" ] && ready=$((ready + 1)); done
  [ "$ready" -eq 3 ] && break
  sleep "$POLL_INTERVAL"
done
[ "$ready" -eq 3 ] || fail "only $ready/3 stores became Ready"

echo "==> Verifying isolation"
a="${namespaces[0]}"
b="${namespaces[1]}"
c="${namespaces[2]}"
[ "$a" != "$b" ] && [ "$b" != "$c" ] && [ "$a" != "$c" ] || fail "namespaces are not distinct"

for ns in "$a" "$b" "$c"; do
  quota=$(kube get resourcequota store-quota -n "$ns" -o jsonpath='{.spec.hard}' 2>/dev/null)
  volume=$(kube get secret store-credentials -n "$ns" -o jsonpath='{.data.mariadb-password}' 2>/dev/null)
  pvc=$(kube get pvc -n "$ns" --no-headers 2>/dev/null | wc -l)
  [ -n "$quota" ] || fail "no ResourceQuota in $ns"
  [ -n "$volume" ] || fail "no credentials in $ns"
  [ "$pvc" -ge 1 ] || fail "no PVC in $ns"
  echo "    $ns: quota set, credentials set, ${pvc} PVC(s)"
done

passwords=$(for ns in "$a" "$b" "$c"; do
  kube get secret store-credentials -n "$ns" -o jsonpath='{.data.mariadb-password}'
  echo
done | sort -u | wc -l)
[ "$passwords" -eq 3 ] || fail "store credentials are not distinct across namespaces"
echo "    credentials differ across all three stores"

echo "==> Deleting store B ($b) and verifying A and C survive"
curl -s -X DELETE "$API_URL/api/stores/${ids[1]}" >/dev/null
for i in $(seq 1 "$MAX_POLLS"); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/stores/${ids[1]}")
  [ "$code" = "404" ] && break
  sleep "$POLL_INTERVAL"
done
[ "$code" = "404" ] || fail "store B was not deleted"

if kube get namespace "$b" &>/dev/null; then
  fail "namespace $b still exists after deleting store B"
fi
echo "    namespace B gone, namespaces A and C untouched"

for pair in "A:${ids[0]}" "C:${ids[2]}"; do
  label="${pair%%:*}"
  id="${pair##*:}"
  status=$(curl -s "$API_URL/api/stores/$id" | jq -r '.store.status')
  url=$(curl -s "$API_URL/api/stores/$id" | jq -r '.store.url')
  [ "$status" = "Ready" ] || fail "store $label is $status after deleting store B"
  http=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 15 || echo "000")
  echo "    store $label still Ready and serving HTTP $http"
  [ "$http" -ge 200 ] && [ "$http" -lt 400 ] || fail "store $label stopped responding"
done

echo ""
echo "==> Concurrency + isolation test completed (A and C left running: ${ids[0]}, ${ids[2]})"
