#!/usr/bin/env bash
# Static chart validation: lint + render every chart and profile, then verify that the API's
# ClusterRole actually covers every resource type the store chart renders.
# Runs without a cluster, so it is the fast pre-commit / CI gate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if ! command -v helm &>/dev/null; then
  echo "ERROR: helm is required"
  exit 1
fi

CHARTS=(charts/store charts/medusa-store helm/platform)

echo "==> Building chart dependencies"
# Vendored subcharts are gitignored, so a fresh checkout has none. Without this, `helm template`
# fails with "found in Chart.yaml, but missing in charts/ directory". Requires network access to
# the Bitnami OCI registry on first run.
# Only rebuild when there is nothing vendored, or when Chart.lock is newer than the vendored
# tarball. `helm dependency build` deletes and rewrites charts/*.tgz, and a second process
# templating the same chart tree at that moment would see a missing dependency - rebuilding on
# every run would make the check unsafe to run concurrently for no benefit.
needs_build() {
  local chart="$1" newest
  compgen -G "$chart/charts/*.tgz" > /dev/null || return 0
  [ -f "$chart/Chart.lock" ] || return 0
  newest=$(ls -t "$chart"/charts/*.tgz | head -1)
  [ "$newest" -nt "$chart/Chart.lock" ] && return 1
  return 0
}

for chart in "${CHARTS[@]}"; do
  if needs_build "$chart"; then
    helm dependency build "$chart" > /dev/null
  fi
  if ! compgen -G "$chart/charts/*.tgz" > /dev/null; then
    echo "ERROR: $chart has no vendored dependencies (and 'helm dependency build' did not produce any)"
    exit 1
  fi
  echo "    $chart: $(ls "$chart"/charts/*.tgz | wc -l) dependency chart(s) vendored"
done

echo "==> Linting charts"
helm lint charts/store
helm lint charts/medusa-store
helm lint helm/platform

echo "==> Rendering charts (both profiles)"
helm template demo-store charts/store -f charts/store/values-local.yaml --set wordpress.ingress.hostname=demo-store.localtest.me > /dev/null
echo "    store chart (local) OK"
helm template demo-store charts/store -f charts/store/values-prod.yaml --set wordpress.ingress.hostname=demo-store.localtest.me > /dev/null
echo "    store chart (prod) OK"
helm template medusa-stub charts/medusa-store > /dev/null
echo "    medusa chart (architecture stub) OK"
helm template urumi helm/platform -f helm/platform/values-local.yaml > /dev/null
echo "    platform chart (local) OK"
helm template urumi helm/platform -f helm/platform/values-prod.yaml > /dev/null
echo "    platform chart (prod) OK"

echo "==> Verifying the WooCommerce init hook renders"
# Only this template is rendered (--show-only) so that a script belonging to a subchart can never
# be mistaken for ours, and to a file rather than a shell variable + pipe so a failure can print
# what was actually rendered instead of just "missing".
render_file=$(mktemp)
helm template demo-store charts/store \
  -f charts/store/values-local.yaml \
  --set wordpress.ingress.hostname=demo-store.localtest.me \
  --show-only templates/woocommerce-init-job.yaml > "$render_file"

if ! grep -q "name: demo-store-woocommerce-init" "$render_file"; then
  echo "ERROR: the WooCommerce init job did not render"
  echo "       rendered: $(wc -l < "$render_file") lines"
  echo "       check woocommerceInit.enabled and charts/store/templates/woocommerce-init-job.yaml"
  rm -f "$render_file"
  exit 1
fi
if ! grep -q 'helm.sh/hook": post-install,post-upgrade' "$render_file"; then
  echo "ERROR: the init job renders but is not a post-install/post-upgrade hook"
  rm -f "$render_file"
  exit 1
fi
echo "    init job renders as a post-install/post-upgrade hook"

echo "==> Syntax-checking the init job's shell script"
# A syntax error here would only surface after a ~10 minute provisioning run, so it is worth
# catching statically. Only this template is rendered (--show-only) so that a script belonging
# to a subchart can never be mistaken for ours.
script_file=$(mktemp)
awk '
    in_script == 0 && /^ *- \|$/ { in_script = 1; next }
    in_script == 1 { match($0, /^ */); indent = RLENGTH; in_script = 2 }
    in_script == 2 {
      if ($0 ~ /^[[:space:]]*$/) { print ""; next }
      match($0, /^ */)
      if (RLENGTH < indent) exit
      print substr($0, indent + 1)
    }
  ' < "$render_file" > "$script_file"
if [ "$(wc -l < "$script_file")" -lt 50 ]; then
  echo "ERROR: could not extract the init script (chart formatting changed?)"
  rm -f "$script_file"
  exit 1
fi
bash -n "$script_file"
# The script must keep the guardrails that make it safe to re-run.
grep -q "is not mounted into" "$script_file" || { echo "ERROR: init script no longer verifies that the PVC data is mounted where WP-CLI expects it"; exit 1; }
grep -q "core is-installed" "$script_file" || { echo "ERROR: init script lost its readiness wait"; exit 1; }
grep -q "payment_gateway update cod" "$script_file" || { echo "ERROR: init script no longer enables COD"; exit 1; }
grep -q "product list --sku" "$script_file" || { echo "ERROR: init script no longer checks for the demo product"; exit 1; }
# Checkout prerequisites: without these the demo flow breaks in ways that are invisible until
# someone actually tries to place an order.
grep -q "show_on_front" "$script_file" || { echo "ERROR: init script no longer fronts the store with the shop page"; exit 1; }
grep -q "has no shop page" "$script_file"
grep -q "option update siteurl" "$script_file"
grep -q "subPath: wordpress" "$render_file" || { echo "ERROR: init job must mount the PVC with the same subPath as the WordPress container"; exit 1; }
grep -q "subPath: wordpress/wp-config.php" "$render_file" || { echo "ERROR: init job must mount wp-config.php where WP-CLI looks for it"; exit 1; }
grep -q "subPath: wordpress/wp-content" "$render_file" || { echo "ERROR: init job must mount wp-content where WP-CLI writes plugins/uploads"; exit 1; } || { echo "ERROR: init script no longer pins the public site URL"; exit 1; } || { echo "ERROR: init script no longer fails when the storefront cannot list products"; exit 1; }
grep -q "enable_for_virtual" "$script_file" || { echo "ERROR: init script no longer allows COD for virtual orders"; exit 1; }
grep -q -- "--virtual=" "$script_file" || { echo "ERROR: init script no longer seeds the product's virtual flag"; exit 1; }
grep -q "not in stock" "$script_file" || { echo "ERROR: init script no longer verifies the demo product is purchasable"; exit 1; }
grep -q "wc product update" "$script_file" || { echo "ERROR: init script no longer converges an existing demo product"; exit 1; }
echo "    init script parses as valid bash ($(wc -l < "$script_file") lines, required steps present)"
rm -f "$script_file" "$render_file"

echo "==> Verifying the API can create everything the store chart renders"
node "$SCRIPT_DIR/check-rbac-coverage.mjs"

echo ""
echo "==> All chart checks passed"
