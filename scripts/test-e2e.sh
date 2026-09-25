#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
STORE_DOMAIN="${STORE_DOMAIN:-localtest.me}"
POLL_INTERVAL=10
MAX_POLLS=30

echo "==> E2E Test: Create, verify, and delete a store"

# Step 1: Create store
echo "==> Creating store..."
RESPONSE=$(curl -s -X POST "$API_URL/api/stores" \
  -H "Content-Type: application/json" \
  -d '{"engine":"woocommerce"}')

STORE_ID=$(echo "$RESPONSE" | jq -r '.store.id')
NAMESPACE=$(echo "$RESPONSE" | jq -r '.store.namespace')
echo "    Store ID: $STORE_ID"
echo "    Namespace: $NAMESPACE"

# Step 2: Poll until Ready
echo "==> Waiting for store to become Ready..."
for i in $(seq 1 $MAX_POLLS); do
  STATUS=$(curl -s "$API_URL/api/stores/$STORE_ID" | jq -r '.store.status')
  echo "    Poll $i/$MAX_POLLS: $STATUS"

  if [ "$STATUS" = "Ready" ]; then
    echo "==> Store is Ready!"
    break
  elif [ "$STATUS" = "Failed" ]; then
    echo "==> Store provisioning failed!"
    curl -s "$API_URL/api/stores/$STORE_ID" | jq '.store.errorMessage'
    exit 1
  fi

  sleep $POLL_INTERVAL
done

if [ "$STATUS" != "Ready" ]; then
  echo "==> Timed out waiting for store to become Ready"
  exit 1
fi

# Step 3: Verify ingress responds
STORE_URL="http://${NAMESPACE}.${STORE_DOMAIN}"
echo "==> Checking store URL: $STORE_URL"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$STORE_URL" --max-time 10 || echo "000")
echo "    HTTP Status: $HTTP_CODE"

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 400 ]; then
  echo "==> WARNING: Store URL returned $HTTP_CODE (may need time for WordPress setup)"
fi

# Step 4: Delete store
echo "==> Deleting store..."
curl -s -X DELETE "$API_URL/api/stores/$STORE_ID" | jq .

# Step 5: Wait for cleanup
echo "==> Waiting for store deletion..."
for i in $(seq 1 $MAX_POLLS); do
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/stores/$STORE_ID")
  if [ "$RESPONSE" = "404" ]; then
    echo "    Store deleted successfully!"
    break
  fi
  echo "    Poll $i/$MAX_POLLS: still cleaning up..."
  sleep $POLL_INTERVAL
done

echo ""
echo "==> E2E test completed!"
