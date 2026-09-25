#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Starting all services (k3s, PostgreSQL, API, Dashboard)..."
docker compose -f docker-compose.dev.yaml up -d --build

echo ""
echo "==> Waiting for services to be healthy..."
echo "    This may take a few minutes on first run (k3s + ingress install)."
echo ""
echo "    Watch progress:  docker compose -f docker-compose.dev.yaml logs -f"
echo ""
echo "==> Once ready:"
echo "    Dashboard + API:  http://localhost:3001"
echo "    API health:       http://localhost:3001/api/health"
echo "    K8s API:          https://localhost:6443"
echo "    Store URLs:       http://store-<id>.localtest.me (nginx ingress on port 80)"
