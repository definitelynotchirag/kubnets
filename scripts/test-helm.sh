#!/usr/bin/env bash
set -euo pipefail

echo "==> Linting store chart..."
helm lint charts/store

echo "==> Dry-run template for store chart (local values)..."
helm template test-store charts/store -f charts/store/values-local.yaml > /dev/null
echo "    Store chart template OK"

echo "==> Linting platform chart..."
helm lint helm/platform

echo "==> Dry-run template for platform chart (local values)..."
helm template test-platform helm/platform -f helm/platform/values-local.yaml > /dev/null
echo "    Platform chart template OK"

echo ""
echo "==> All Helm charts are valid!"
