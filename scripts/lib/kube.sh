#!/usr/bin/env bash
# Cluster access for the verification scripts.
#
# These scripts assert real Kubernetes state, so they must never silently skip those checks.
# Instead of requiring a host kubectl, the access method is resolved once here:
#
#   auto (default) : host `kubectl`/`helm` when present, otherwise the k3s container that the
#                    docker-compose development environment runs (it ships kubectl, and the API
#                    container ships helm + a kubeconfig).
#   host           : always use `KUBECTL` (default: kubectl) and `HELM` (default: helm).
#   docker         : always go through `docker compose exec` into the k3s / api containers.
#
# Usage: source this file, then call `kube ...` and `helmk ...`.

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev.yaml}"
KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"

if [ -n "${KUBECTL_MODE:-}" ] && [ "${KUBECTL_MODE}" != "auto" ]; then
  KUBE_MODE="${KUBECTL_MODE}"
elif command -v "$KUBECTL" >/dev/null 2>&1; then
  KUBE_MODE=host
elif command -v docker >/dev/null 2>&1; then
  KUBE_MODE=docker
else
  KUBE_MODE=none
fi

case "$KUBE_MODE" in
  host)
    kube() { "$KUBECTL" "$@"; }
    helmk() { "$HELM" "$@"; }
    ;;
  docker)
    command -v docker >/dev/null 2>&1 || {
      echo "ERROR: KUBECTL_MODE=docker but docker is not installed" >&2
      exit 1
    }
    kube() { docker compose -f "$COMPOSE_FILE" exec -T k3s kubectl "$@"; }
    helmk() { docker compose -f "$COMPOSE_FILE" exec -T api helm "$@"; }
    ;;
  *)
    echo "ERROR: neither kubectl nor docker is available. Install kubectl and point KUBECONFIG" >&2
    echo "       at the cluster (see README, 'Docker Compose'), or set KUBECTL_MODE=docker." >&2
    exit 1
    ;;
esac

export KUBE_MODE
