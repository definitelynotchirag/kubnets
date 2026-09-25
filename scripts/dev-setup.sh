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
echo "    Dashboard:  http://localhost:5173"
echo "    API:        http://localhost:3001/api/health"
echo "    K8s API:    https://localhost:6443"
