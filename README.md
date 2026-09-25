# Kubnets — Multi-Tenant Store Provisioning Platform

A Kubernetes-native platform that provisions isolated ecommerce stores on demand. A store is a
namespace, a WordPress + WooCommerce deployment, its own MariaDB, its own volumes, its own
credentials, and its own ingress — created, watched and torn down by the platform.

WooCommerce is fully implemented (including a seeded product and a working Cash-on-Delivery
checkout). MedusaJS is an architectural stub — the engine seam exists, the engine does not.

---

## Verification status — read this before trusting anything below

| Layer | Status |
|---|---|
| Type checks, unit + integration tests (fake Kubernetes API, stub Helm), chart lint/render, RBAC coverage check, shell syntax | **Verified** — see [Verification](#verification) |
| Live: platform running **on** Kubernetes (k3s via k3d, VPS), a real store provisioned by that deployment with its own ServiceAccount, WooCommerce checkout placing a real order, store deletion, startup reconciliation | **Verified** (run of 2026-09-23 — evidence below) |
| Live: scripted crash recovery (`test:crash-recovery.sh`) | **Verified** — API hard-killed mid-provisioning (grace period 0), startup reconciliation requeued the store, provisioning converged to `Ready`, no duplicate resources, credentials byte-identical (`CRASH_EXIT=0`) |
| Live: concurrency + isolation (`test:concurrency.sh`) | **Verified** — three stores created back-to-back all reached `Ready` (third queued while `MAX_CONCURRENT_PROVISIONS=2` was saturated), per-store quota/credentials/2 PVCs present, credentials distinct across tenants, then store B deleted while A and C stayed `Ready` and served `HTTP 200` (`CONC_EXIT=0`) |
| Cross-tenant NetworkPolicy enforcement | **Measured** — from a store's own WordPress pod: its own namespace's Service answers `200` (allow-internal), while another store's Service is refused (default-deny). The target had live endpoints, so the block came from the policy, not a missing backend |

### Live verification record (2026-09-23)

Deployed on a 1 vCPU VPS (Ubuntu 24.04, k3s in k3d, pre-existing nginx kept on 80/443 with k3d on
8080/8443 and a nip.io wildcard vhost in front). Observed:

* `helm upgrade --install urumi ./helm/platform -f values-local.yaml` → release `deployed`;
  API, dashboard and PostgreSQL pods `Running`; `http://<host>/api/health` → `{"status":"ok"}`
  from an external machine.
* Store created through the public API → `Pending → Provisioning → Ready`; the API (own
  ServiceAccount, no admin kubeconfig) created the namespace, `ResourceQuota`, `LimitRange`, four
  NetworkPolicies, the credentials Secret, and the store Helm release.
* Init Job log: plugin activated → pages created → site URL pinned → front page set → COD enabled
  for virtual orders → free-shipping zone seeded → demo product published and in stock.
* Checkout over the Store API (the path the block checkout uses): add-to-cart `201` with
  `Demo Product`, checkout `200` → `order_id 12`, `status processing`, `payment Cash on delivery`,
  `total 10.00`; product stock `100 → 99`. Read back through WooCommerce itself
  (`wc_get_orders`).
* Deletion: `helm uninstall` → namespace removed → record removed, including after a failed
  release and a namespace that first refused to terminate.
* Failure path: when initialization failed, the store went `Failed` (never `Ready`) with the init
  Job's log tail in `errorMessage`.
* Isolation measured with positive and negative controls: same-namespace Service `200`,
  cross-tenant Service refused.
* `scripts/test-e2e.sh` passed end-to-end against this deployment (`E2E_EXIT=0`): store `Ready`,
  namespace + 3 pods + 2 bound PVCs + credentials secret + 6 NetworkPolicies + Helm release +
  init Job `Complete`, storefront `HTTP 200` with **Demo Product visible at `/shop/`**, then
  deletion removed both the record and the namespace.
* Three stores were `Ready` at the same time during the run (each in its own namespace with its
  own database, credentials and ingress host), and the leaked ones from earlier failed attempts
  were deleted cleanly through the API.
* Crash recovery: `test-crash-recovery.sh` passed (`CRASH_EXIT=0`) — the API pod was force-deleted
  mid-provisioning, reconciliation requeued the stale store on startup, and it reached `Ready`
  with a single namespace and byte-identical credentials.

The automated checks deliberately substitute fakes for the cluster. They prove the *logic* —
convergence, credential reuse, deletion retries, reconciliation, probe behaviour — and nothing
more. They cannot prove that a real API server accepts every object we send, that pods become
ready, that the init Job's WP-CLI steps work against the Bitnami image, that the storefront
serves a product, or that an order can actually be placed. **A green `npm test` is not a working
platform.**

Closing this out requires, in order:

```bash
npm run deploy:local          # platform inside k3d, using its own ServiceAccount
npm run test:e2e              # create → Ready → k8s objects → storefront lists the product → delete → namespace gone
npm run test:concurrency      # 3 stores at once, per-store isolation, delete one, others survive
npm run test:crash-recovery   # kill the API mid-provision, restart, converge, credentials unchanged
```

plus the manual checkout walkthrough below (cart → Cash on Delivery → order → wp-admin → restart
a pod and confirm the order is still there). Anything not exercised by those commands is an
untested claim.

---

## Architecture

```
React dashboard  ──►  Express API (TypeScript)  ──►  PostgreSQL (Prisma)
                            │
                            ├──► p-limit provisioning worker (in-process queue)
                            │
                            ▼
                    Helm CLI + Kubernetes API
                            │
                            ▼
                     Kubernetes cluster
        ┌───────────────────────┬───────────────────────┐
        │ store-a namespace     │ store-b namespace     │
        │  WordPress+WooCommerce│  WordPress+WooCommerce│
        │  MariaDB  (StatefulSet)  MariaDB              │
        │  PVCs, Ingress, Secret │  PVCs, Ingress, Secret│
        │  NetworkPolicies       │  NetworkPolicies      │
        │  ResourceQuota, Limits │  ResourceQuota, Limits│
        └───────────────────────┴───────────────────────┘
```

Responsibilities:

| Component | Job |
|---|---|
| Dashboard (`dashboard/`) | Creates stores, shows status/URL/timestamps, activity log, deletion |
| API (`api/src/routes`, `services`) | Store lifecycle, quotas, rate limiting, audit log, metrics |
| Provisioning worker (`api/src/workers`) | Bounded concurrency, per-store serialization, crash recovery |
| `charts/store` | One WooCommerce store (wraps the Bitnami WordPress + MariaDB charts) |
| `helm/platform` | The platform itself: API, dashboard, PostgreSQL, ServiceAccount + RBAC |

Store lifecycle:

```
Pending ──► Provisioning ──► Ready
                 │              │
                 ▼              ▼
              Failed ◄──── (deletion failure)
                 │
                 ▼
             Deleting ──► (record removed)
```

`Ready` means three things have succeeded: Helm (workloads ready **and** the WooCommerce init
Job completed), and the storefront answered an HTTP request. It is not just "the pod is up".

---

## Repository layout

```
api/                  Express API + provisioning worker + Prisma schema
dashboard/            React dashboard (Vite + TanStack Query + Tailwind)
packages/shared/      Types and Zod schemas shared by API and dashboard
charts/store/         WooCommerce store chart (Bitnami WordPress + MariaDB subcharts)
charts/medusa-store/  MedusaJS chart — architecture stub, not provisionable
helm/platform/        Platform chart (API, dashboard, PostgreSQL, RBAC)
scripts/              Setup, deployment, and verification scripts
docker-compose.dev.yaml  Local dev environment (k3s in Docker + Postgres + API/dashboard)
```

---

## Local setup

### Option A — full platform inside Kubernetes (canonical demo)

This is the path that proves the platform works with its own ServiceAccount: the API runs as a
pod, provisions with RBAC, and never touches an admin kubeconfig.

Prerequisites: `docker`, `k3d`, `kubectl`, `helm`.

```bash
./scripts/deploy-platform-local.sh
```

What it does, step by step (run it manually if you prefer):

```bash
./scripts/k3d-setup.sh                      # k3d cluster + nginx ingress controller

docker build -f api/Dockerfile       -t urumi-api:local .
docker build -f dashboard/Dockerfile -t urumi-dashboard:local .
k3d image import urumi-api:local urumi-dashboard:local -c urumi

helm dependency build helm/platform
helm upgrade --install urumi ./helm/platform \
  --namespace urumi-system \
  --create-namespace \
  -f helm/platform/values-local.yaml \
  --set api.image.tag=local --set dashboard.image.tag=local \
  --wait --timeout 10m

kubectl -n urumi-system get deploy,svc,sa
```

Dashboard: <http://urumi.localtest.me/> (or `kubectl -n urumi-system port-forward svc/urumi-platform-dashboard 8080:8080`).

> Local images are not in a registry. `values-local.yaml` sets `pullPolicy: Never`, so the
> images must be imported into the cluster (`k3d image import`) — a plain `docker build` is not
> enough.

### Option B — Docker Compose development loop

Faster iteration, same code paths for provisioning (k3s runs in a container and the API talks to
its API server through a shared kubeconfig).

```bash
docker compose -f docker-compose.dev.yaml up -d --build
docker compose -f docker-compose.dev.yaml logs -f api
```

Dashboard + API: <http://localhost:3001>

Difference that matters: here the API runs **outside** the cluster, so its readiness probe
targets the ingress (`STORE_PROBE_MODE=ingress`, `STORE_PROBE_INGRESS_HOST=k3s`) instead of the
store's in-cluster Service. Both modes are exercised; the probe itself is always required.

The cluster's API server is published on `localhost:6443`, so `kubectl`/`helm` on your host can
talk to it once you export the kubeconfig (needed by the verification scripts below, and handy
for inspecting stores by hand):

```bash
docker compose -f docker-compose.dev.yaml cp k3s:/output/kubeconfig.yaml ./kubeconfig.yaml
# the cluster is reachable as 127.0.0.1 inside the k3s certificate SANs
sed -i 's|https://k3s:6443|https://127.0.0.1:6443|' ./kubeconfig.yaml
export KUBECONFIG="$PWD/kubeconfig.yaml"
kubectl get ns
```

---

## Creating a store

1. Open the dashboard and click **New Store**.
2. Choose **WooCommerce** (MedusaJS is disabled — it is an architecture stub).
3. Watch the status go `Pending → Provisioning → Ready` (typically 2–5 minutes: image pulls
   dominate the first run).

From the API instead:

```bash
curl -X POST http://localhost:3001/api/stores \
  -H 'Content-Type: application/json' -d '{"engine":"woocommerce"}'
```

Concurrency is bounded by `MAX_CONCURRENT_PROVISIONS` (default 3); create several stores at once
and they provision in parallel, each in its own namespace.

### What the platform does during provisioning

```
ensure namespace  ->  ensure ResourceQuota + LimitRange  ->  ensure NetworkPolicies
      ->  ensure credentials (reuse if present)  ->  helm upgrade --install --wait --wait-for-jobs
      ->  WooCommerce init Job (post-install/post-upgrade hook)  ->  HTTP probe  ->  Ready
```

---

## Application checkout walkthrough (manual demo)

This is the part that proves the store is a real store, not a running pod.

1. Open the store URL shown in the dashboard (`http://store-<id>.localtest.me`).
2. The homepage **is the shop page** and lists **Demo Product** (SKU `demo-product`, price 10) —
   the init Job seeds it, sets the shop page as the site front page and disables WooCommerce
   "coming soon" mode.
3. Click it, **Add to cart**, then go to the cart and **Proceed to checkout**.
4. Fill in the billing details, keep **Cash on delivery** selected, and place the order.
5. Open `http://store-<id>.localtest.me/wp-admin` and log in as `admin` (password below).
6. **WooCommerce → Orders** shows the order.

Two WooCommerce details that would otherwise break this flow, and how they are handled:

* **The seeded product is virtual.** A physical product cannot be checked out until a shipping
  method exists, and a fresh WooCommerce store has none — checkout stops at *"There are no
  shipping options available"*. The init Job therefore seeds the product as virtual and enables
  Cash on Delivery *for virtual orders*, and additionally seeds a free-shipping zone (best effort)
  so physical products you add later are checkoutable too. Set
  `woocommerceInit.product.virtual=false` only together with real shipping configuration.
* **A missing shop page is fatal, not a warning.** A blog homepage still answers HTTP 200, so a
  store with no product would look "reachable" and be marked `Ready`. The init Job publishes the
  shop page, fronts the site with it, and fails if it cannot.

If the product is missing, the init Job is the thing to read:

```bash
kubectl logs -n store-<id> job/store-<id>-woocommerce-init
```

It is convergent, not just create-once: re-running `helm upgrade` re-runs it, plugin activation is
looked up before it is attempted, and an existing demo product is **updated** to the desired name,
price, virtual flag and stock rather than skipped — so a store seeded by an earlier revision is
brought back into line instead of keeping a product that cannot be checked out.

---

## Credentials

Every store gets its own Secret, generated once by the platform and never rotated by a retry:

```bash
# WordPress admin password
kubectl get secret -n store-<id> store-credentials \
  -o jsonpath='{.data.wordpress-password}' | base64 -d

# MariaDB passwords (root, app user, replication)
kubectl get secret -n store-<id> store-credentials -o jsonpath='{.data}' | jq
```

The chart consumes that Secret through `wordpress.existingSecret` and
`wordpress.mariadb.auth.existingSecret`. Credentials are deliberately **not** passed with
`helm --set`, because Helm stores `--set` values verbatim in the release Secret — anyone able to
read `sh.helm.release.*` would otherwise read every store's database password.

---

## Deleting a store

Dashboard trash icon, or:

```bash
curl -X DELETE http://localhost:3001/api/stores/<id>
```

Order of operations: `helm uninstall` (skipped if the release is already gone) → delete the
namespace → wait until the namespace is really gone → audit → delete the database record.

Deletion is retryable. If it fails, the store is marked `Failed` with a `Deletion failed: …`
message, and a second `DELETE` request (or a restart) retries it.

**PVC caveat:** deleting the namespace deletes the PersistentVolumeClaims, but whether the
backing volume is released depends on the StorageClass reclaim policy (`Retain` volumes survive
with their data, `Delete` volumes are destroyed). That is a storage-class decision, not an
application one — worth being explicit about in a production review.

---

## Failure handling

| Situation | Behaviour |
|---|---|
| API crashes mid-provision | Store stays `Provisioning`; startup reconciliation re-enqueues it; every step converges |
| API crashes with a `Pending` row | Startup reconciliation provisions it (the row is not stranded) |
| API crashes mid-delete | Store stays `Deleting`; startup reconciliation retries the deletion |
| Helm release already exists | `helm upgrade --install` reconciles instead of failing |
| API dies mid-install/mid-upgrade | The release is left `pending-*`; the next provisioning run clears it first (uninstall for an incomplete install, rollback for an interrupted upgrade) and converges |
| Namespace / quota / policies / secret already exist | Namespace: read-then-create. Quota/limits/policies: read, then replace with the desired spec. Secrets: read and reuse |
| Provisioning fails | Store becomes `Failed` with the failing step and, for init failures, the init Job's log tail |
| Failed store | Never auto-retried — it stays inspectable until you delete it |
| Deletion fails | `Failed` + `Deletion failed: …`; another `DELETE` retries it |
| Store has no traffic yet (probe times out) | `Failed` with the probed URL and the last HTTP status |
| Init Job cannot make the store sellable | Job fails → Helm hook fails → store `Failed` with the Job's log tail (never a silent `Ready`) |

Startup reconciliation is logged as `reconciliation_started`, `stale_pending_found`,
`stale_provisioning_found`, `stale_deleting_found`, `store_requeued`, `failed_stores_skipped`,
`reconciliation_complete`.

---

## Abuse controls and observability

| Control | Value |
|---|---|
| Global rate limit | 100 req/min/IP |
| Store creation limit | 5/min/IP |
| Maximum stores | `MAX_STORES` (default 5) |
| Concurrent provisioning | `MAX_CONCURRENT_PROVISIONS` (default 3) |
| Provisioning timeout | `HELM_TIMEOUT` (default 10m) |
| Per-namespace quota | 2 CPU, 2 GiB memory, 10 pods, 4 PVCs |
| LimitRange defaults | 250m CPU / 256Mi memory per container |

Endpoints: `GET /api/health`, `GET /api/stores`, `POST /api/stores`, `GET /api/stores/:id`,
`DELETE /api/stores/:id`, `GET /api/stores/:id/logs`, `GET /api/audit-logs`, `GET /api/metrics`.
Audit actions (one per real step, shown live in the dashboard's activity panel):
`store.created`, `store.provisioning`, `store.namespace_ready`, `store.credentials_ready`,
`store.helm_started`, `store.helm_ready`, `store.verifying`, `store.ready`, `store.failed`,
`store.delete_requested`, `store.helm_uninstalled`, `store.namespace_deleted`, `store.deleted`. Logs are structured JSON (pino).

---

## Security model

* **Namespace per store** — the isolation boundary for RBAC, quotas, NetworkPolicies and teardown.
* **NetworkPolicies per store** — `default-deny-ingress`, `allow-ingress-controller`,
  `allow-internal`, `allow-platform-ingress`. The Bitnami subchart's own policy is set to
  `allowExternal: false`, because its default would accept ingress from *any* namespace and
  silently undo the isolation.
* **ResourceQuota + LimitRange** — a single store cannot starve the cluster.
* **Least privilege for the API** — `helm/platform/templates/api-clusterrole.yaml` grants only
  the resource types the store charts actually render; no wildcards, no RBAC objects, no nodes,
  no CRDs. Coverage is verified statically by `npm run check:rbac`, which renders the store
  chart, collects every kind it creates, and asserts the ClusterRole can manage each one.
  Tradeoff: namespace creation is cluster-scoped, and a ClusterRole bound to the ServiceAccount
  applies to the listed resource types in every namespace. It cannot be narrowed with
  `resourceNames` (create cannot be name-scoped) or replaced with per-store Roles without
  granting the API `roles`/`rolebindings` plus `escalate` — a bigger privilege, not a smaller one.
* **No production secrets in source** — store credentials are generated per store; the platform
  database uses an operator-created Secret in production (see below).
* **Container hardening** — API and dashboard run as non-root (UID 1000) with
  `readOnlyRootFilesystem`, all capabilities dropped, `allowPrivilegeEscalation: false` and
  `seccompProfile: RuntimeDefault`; `/tmp` is an `emptyDir` because Helm needs writable
  cache/config/data directories. Store pods use the Bitnami non-root defaults (UID 1001), and
  the init Job runs with the same UID, minimal capabilities, and no privilege escalation.

**NetworkPolicy enforcement:** enforcement is the CNI's job.
k3s (used by both local paths and the suggested VPS setup) enforces NetworkPolicy through its
built-in controller; a cluster whose CNI ignores NetworkPolicy would accept the objects but not
enforce them. This repository does not claim enforcement was measured on your cluster — verify
it there before relying on it.

---

## Local vs production (Helm only, no code changes)

| Setting | Local (`values-local.yaml`) | Production (`values-prod.yaml`) |
|---|---|---|
| `HELM_VALUES_PROFILE` | `local` → store `values-local.yaml` | `prod` → store `values-prod.yaml` |
| `STORE_DOMAIN` | `localtest.me` | `stores.example.com` |
| `STORE_URL_SCHEME` | `http` | `https` |
| StorageClass | `local-path` | provider/cloud class |
| Ingress TLS | off | cert-manager (`letsencrypt-prod`) |
| Store resources | 256–512Mi | 512Mi–1Gi |
| Platform DB credentials | Secret created by `deploy-platform-local.sh` (random, never in values) | Secret created by your secret manager, same key names |
| Images | imported into k3d, `pullPolicy: Never` | registry (e.g. GHCR) with an immutable tag |

Both profiles render identically in shape; only values differ.

---

## Production-like k3s deployment

1. **Images** — a VPS cannot pull images that only exist on a laptop. Push them somewhere:

   ```bash
   docker build -f api/Dockerfile       -t ghcr.io/<owner>/kubnets-api:v0.2.0 .
   docker build -f dashboard/Dockerfile -t ghcr.io/<owner>/kubnets-dashboard:v0.2.0 .
   docker push ghcr.io/<owner>/kubnets-api:v0.2.0
   docker push ghcr.io/<owner>/kubnets-dashboard:v0.2.0
   ```

   Prefer an immutable tag (or digest) over `latest` in anything long-lived.

2. **Secrets** — never in values:

   ```bash
   DB_PASSWORD="$(openssl rand -hex 24)"   # hex is safe verbatim inside a PostgreSQL URI
   kubectl create namespace urumi-system
   kubectl -n urumi-system create secret generic urumi-postgres \
     --from-literal=postgres-password="$DB_PASSWORD" \
     --from-literal=password="$DB_PASSWORD" \
     --from-literal=username=urumi \
     --from-literal=database=urumi \
     --from-literal=DATABASE_URL="postgresql://urumi:$DB_PASSWORD@urumi-platform-postgresql:5432/urumi"
   ```

   `values-prod.yaml` points `postgresql.auth.existingSecret` and `api.databaseUrlSecret` at it,
   so Helm renders no password at all.

3. **DNS + TLS** — wildcard DNS (`*.stores.example.com` → VPS IP) and cert-manager with a
   `letsencrypt-prod` ClusterIssuer; `values-prod.yaml` already requests TLS on the platform
   ingress and the store charts request it too.

4. **Deploy:**

   ```bash
   helm dependency build helm/platform
   helm upgrade --install urumi ./helm/platform \
     --namespace urumi-system --create-namespace \
     -f helm/platform/values-prod.yaml \
     --set api.image.repository=ghcr.io/<owner>/kubnets-api \
     --set api.image.tag=v0.2.0 \
     --set dashboard.image.repository=ghcr.io/<owner>/kubnets-dashboard \
     --set dashboard.image.tag=v0.2.0 \
     --wait --timeout 10m
   ```

5. **Storage** — set a StorageClass that fits your durability requirements in
   `charts/store/values-prod.yaml`, and confirm its reclaim policy matches what you want to
   happen when a tenant is deleted.

---

## Upgrade and rollback

Store releases (per store):

```bash
helm history store-<id> -n store-<id>
helm upgrade store-<id> ./charts/store -n store-<id> \
  -f charts/store/values-prod.yaml \
  --set wordpress.ingress.hostname=store-<id>.stores.example.com \
  --set wordpress.existingSecret=store-credentials \
  --set wordpress.mariadb.auth.existingSecret=store-credentials \
  --wait --wait-for-jobs
helm rollback store-<id> 1 -n store-<id>
```

Platform:

```bash
helm history urumi -n urumi-system
helm rollback urumi -n urumi-system
```

Rollback caveat worth stating out loud: rolling back the *application* is not the same as rolling
back its *database*. Image/config rollbacks are safe; schema migrations are not automatically
reversible, so treat a platform rollback as an application rollback and handle data separately.

---

## Scaling (honest limits)

The current worker is an in-memory queue inside the API process:
`p-limit(MAX_CONCURRENT_PROVISIONS)` plus per-store serialization so a store is never provisioned
and deleted at the same time.

* **One API replica.** A second replica would run its own queue: two processes could provision the
  same store concurrently, and startup reconciliation would fire twice. `helm/platform` pins
  `api.replicas: 1` for this reason.
* **To scale out**, move provisioning to a shared work queue: BullMQ/Redis, Kubernetes Jobs, or a
  leased-work table in PostgreSQL. The convergence guarantees stay valid — every step is an
  idempotent ensure, and `helm upgrade --install` is safe to repeat — so only job *ownership*
  changes.
* **Throughput is bounded by Helm and the cluster**, not by the API: each store provisions a
  WordPress deployment, a MariaDB StatefulSet and volumes.
* **MariaDB per store** is the isolation/cost tradeoff: strong tenant isolation and simple
  lifecycle at the price of memory. At scale, a managed or shared database tier with a database
  per store would cut resource usage. That is a deliberate Round-1 decision, not an oversight.

---

## Verification

Runs without a cluster (fast feedback):

```bash
npm test              # API unit + integration tests (fake Kubernetes API, stub Helm)
npm run check:charts  # helm lint + render both charts and profiles + init-script syntax check
npm run check:rbac    # renders the store chart and proves the ClusterRole covers every kind
```

What the tests actually cover: convergent provisioning (no duplicate resources, credentials
reused, `helm upgrade --install`), credential reuse on retry, repeatable deletion, startup
reconciliation of stale rows, and the readiness probe (retry loop, Host header, deadline).

Runs against a live cluster. Cluster access is resolved by `scripts/lib/kube.sh`: it uses host
`kubectl`/`helm` when they exist, otherwise it routes through `docker compose exec` into the k3s
and api containers (`KUBECTL_MODE=host|docker|auto`, default `auto`). If neither is available the
scripts exit with an error instead of skipping assertions — a green run really does mean the
Kubernetes objects were checked:

```bash
npm run test:e2e             # create → Ready → namespace/pod/PVC/secret/networkpolicy/release/init-job
                             # checks → storefront + seeded product reachable → delete → namespace gone
npm run test:concurrency     # three stores at once, per-store namespace/quota/PVC/credentials isolation,
                             # delete one, verify the other two still serve
npm run test:crash-recovery  # kill the API mid-provision, restart, converge, credentials unchanged
```

---

## Engine extensibility (MedusaJS)

MedusaJS is present to show the seam, not to work:

1. `StoreEngine` in `packages/shared` (`"woocommerce" | "medusa"`),
2. chart routing in `api/src/services/helm.service.ts` (`getChartPath`, `getEngineSetArgs`),
3. a second chart in `charts/medusa-store/`,
4. engine-specific Helm values.

The API rejects `{"engine":"medusa"}` with **501** and a clear message, and the dashboard shows
MedusaJS as *Coming soon*, so nobody can accidentally provision a half-built store.
Round 1 fully implements WooCommerce; adding a real engine means completing its chart and adding
its init/readiness steps — no changes to the provisioning core.
