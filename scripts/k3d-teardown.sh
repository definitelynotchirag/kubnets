#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="urumi"

echo "==> Deleting k3d cluster '$CLUSTER_NAME'..."
k3d cluster delete "$CLUSTER_NAME"
echo "==> Cluster '$CLUSTER_NAME' deleted."
