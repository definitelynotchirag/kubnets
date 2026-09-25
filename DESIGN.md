# System Design & Tradeoffs

This document describes what the system **actually does today**. Anything aspirational is
labelled as such under `Production evolution`, and every design decision carries its tradeoff.
Claims here are meant to survive a code review: if it is written down, it is in the code.

---

## Architecture choices

### Why Helm + `execa` instead of a JS Helm SDK

There is no maintained JavaScript Helm SDK that tracks Helm's semantics (release storage, hooks,
`--wait` behaviour). Shelling out to the Helm CLI is what Argo CD, Flux and Rancher do.

* **Tradeoff:** the API image must ship a `helm` binary (pinned to `v3.22.0` in
  `api/Dockerfile`) and behaviour is coupled to that version's flags (`--wait-for-jobs` is used
  to wait for the WooCommerce init Job).
* **Tradeoff:** Helm runs with the API's ServiceAccount, so the RBAC surface is whatever the
  store charts render (see below) rather than a fixed set of API calls.

### Why a per-store Helm chart (and a wrapper chart in front of Bitnami)

`charts/store` wraps the Bitnami WordPress chart (which itself bundles MariaDB) and adds the
WooCommerce-specific pieces: the init Job and the per-store values. Writing WordPress + MariaDB
manifests by hand would be a much larger correctness surface with no benefit.

* **Tradeoff:** three levels of chart (our chart → wordpress → mariadb) make name derivation
  subtle. `<release>-wordpress` / `<release>-mariadb` naming is derived by helpers that mirror
  Bitnami's `common.names.fullname` collapse rule, so a Job referring to the MariaDB Service
  cannot silently point at the wrong name (`charts/store/templates/_helpers.tpl`).

### Why `p-limit` in an in-process queue instead of Redis/BullMQ/Kubernetes Jobs

For a single API instance, an in-memory limiter plus a per-store promise chain is enough, and it
keeps the deployment to one moving part. Store work for a single store is serialized so a delete
requested during provisioning is *queued behind it* rather than dropped (`provisioning` skips
stores that are being deleted, so it cannot overwrite `Deleting`).

* **Implemented now:** bounded concurrency (`MAX_CONCURRENT_PROVISIONS`, default 3), per-store
  ordering, startup reconciliation, in-flight state kept in memory only.
* **Tradeoff:** it is not distributed. Two API replicas would each run their own queue and could
  provision the same store twice. `helm/platform` therefore pins `api.replicas: 1`.
* **Production evolution:** a shared queue (BullMQ/Redis, Kubernetes Jobs, or a leased-work table
  in PostgreSQL) with the same idempotent steps. Nothing in the convergence logic would change.

### Why Prisma + PostgreSQL

The desired state of every store lives in one table, which is what makes recovery possible: after
a crash, the database says what *should* exist and the reconciler makes the cluster match.

* **Tradeoff:** the schema is applied by `prisma migrate deploy` at container start, which is
  fine for a single instance but is not a migration strategy for many replicas (a migration Job
  would be the standard answer).

### Why namespace-per-store

* Isolation for quotas, NetworkPolicies and (future) RBAC;
* a single `kubectl delete namespace` is a complete, ordered teardown;
* failures are debuggable in one place (`kubectl get all -n store-x`).

### Why MariaDB per store

Strong isolation and a simple lifecycle (the database dies with the namespace).

* **Tradeoff:** memory and storage cost scale linearly with tenants, and there is no shared
  backup/upgrade story. At scale, a managed database tier with one database per store would be
  cheaper; the platform's contract (one store = one isolated data store) would not change.

---

## Provisioning is idempotent (a convergence loop)

Provisioning is not a script that runs once; it is a set of "ensure desired state" operations, so
running it again is always safe:

```
ensureNamespace        (read -> create; 409 during a race is success)
ensureResourceQuota    (read -> create, else replace with the desired spec)
ensureLimitRange       (read -> create, else replace with the desired spec)
ensureNetworkPolicies  (read -> create, else replace; four policies)
ensureStoreSecrets     (read -> reuse, else create; 409 during a race re-reads)
helm upgrade --install --wait --wait-for-jobs   (existing release reconciles)
HTTP probe             (storefront must answer before Ready)
```

Deliberate details:

* **Credentials are never regenerated.** `ensureStoreSecrets` reads `store-credentials` first and
  returns the existing values. Rotating the MariaDB password of a running store would lock
  WordPress out of its own database. If a required key is missing, the platform fails loudly
  instead of silently inventing a new password.
* **Passwords never travel through `helm --set`.** Helm stores `--set` values verbatim in the
  release Secret, so passing credentials that way would expose every store's database password to
  anyone who can read `sh.helm.release.*`. The chart consumes `existingSecret` instead, and the
  API passes only the secret *name*.
* **Re-running provisioning on a `Ready` store converges** (Helm reconciles, credentials are
  reused) — it does not create a second store or destroy data.
* **Convergence uses PUT (`replace`), not PATCH.** `@kubernetes/client-node` 1.x sends PATCH as
  `application/json-patch+json` while these desired states are merge-patch documents, which a real
  API server rejects; a replace is also stricter — fields that left the desired state actually go
  away instead of lingering. The update carries the `resourceVersion` read from the server (what
  `kubectl replace` does), so a concurrent writer yields a 409 rather than a lost update;
  `ensureObject` re-reads and retries a bounded number of times, and recreates the object if it
  disappeared between the read and the write. The integration test enforces both rules against a
  fake API server, so a regression to blind overwrites or to PATCH fails the suite.

---

## Readiness means "usable", not "pod is up"

Helm's `--wait` proves the workloads are ready and (with `--wait-for-jobs`) that the WooCommerce
init Job finished. On top of that, the API probes the storefront over HTTP and only then marks the
store `Ready`.

* **Probe target is configurable, the probe is not.** `STORE_PROBE_MODE=service` (default, when
  the platform runs in-cluster) dials `<release>-wordpress.<ns>.svc.cluster.local`; `ingress`
  dials the ingress front door for the docker-compose setup where the API is outside the cluster.
  There is no "skip the probe" switch — a `Ready` store has served at least one HTTP request.
* The probe uses `node:http`, not `fetch`: `fetch` drops the `Host` header (forbidden per spec)
  and follows redirects, which for WordPress would chase the public hostname from inside the
  cluster. The probe sends the public hostname as `Host` and treats any status `< 400` as success
  (a 200 or a 301 both prove the web tier is serving).

### The WooCommerce init Job (`charts/store/templates/woocommerce-init-job.yaml`)

Installing the WooCommerce plugin is not enough for the assignment: a fresh store must *sell*
something. The init Job runs as a Helm `post-install,post-upgrade` hook with
`hook-delete-policy: before-hook-creation` and:

1. waits for `wp-config.php` and `wp core is-installed` (WordPress + MariaDB actually up),
2. installs/activates WooCommerce (idempotently),
3. creates the shop/cart/checkout pages, sets permalinks, currency and store country,
4. turns off WooCommerce's "coming soon" mode (fresh WooCommerce 9.x hides the storefront
   otherwise — an easy way to ship a store that looks broken),
5. enables **Cash on Delivery** (works with no payment provider),
6. seeds **Demo Product** by looking it up by SKU first.

*Bash discipline in the hook matters more than it looks.* `set -euo pipefail` plus an unguarded
command substitution whose stderr is redirected produces a **silent** exit: the Job dies with no
output, and you debug a "crash" that is actually a failed probe. Every probe in the script is
therefore `|| true`-guarded, and every genuine check logs an explicit `ERROR:` line before exiting.

**Third-party images are pinned deliberately.** Bitnami moved versioned tags out of
`bitnami/*` into `bitnamilegacy/*`, so the version pinned inside the PostgreSQL subchart stopped
resolving and the pod sat in `ImagePullBackOff` while Helm still reported the release deployed.
`helm/platform/values.yaml` therefore pins `bitnamilegacy/postgresql:17.6.0-debian-12-r4` (a real
version rather than a floating `latest`), and the store chart's WordPress/MariaDB images come from
the subcharts' own `latest` defaults, which still resolve.

*Running it inside the WordPress pod instead of as a Job was rejected: `kubectl exec` requires
`pods/exec` RBAC and moves the work out of the declarative path. A plain Job (no hook) was
rejected too: Jobs are effectively immutable, so a failed init could never be retried by
re-running Helm. The hook + delete policy is what makes retries possible.*

Three details in there are the difference between "a running pod" and "a store that can take an
order", and each of them fails *quietly* if you get it wrong:

| Detail | What goes wrong without it | How it is handled |
|---|---|---|
| The product is **virtual** | A physical product needs a shipping method; a fresh store has none, so checkout dead-ends at "no shipping options available" | Seed `--virtual=true`, enable COD for virtual orders (`woocommerce_cod_settings.enable_for_virtual`), and additionally seed a free-shipping zone for physical products (best effort) |
| The **shop page fronts the site** | WordPress serves the default blog; the store URL returns 200 with no product on it, so readiness passes on a store nobody can buy from | Publish the shop page, set `show_on_front`/`page_on_front`, and treat a missing shop page as fatal |
| The existing product is **converged** | Re-running the Job on a store seeded by an earlier revision would "succeed" while leaving the broken product in place | `wc product update` with the same desired fields instead of skipping when the SKU exists |
| The Job **mounts what the WordPress container mounts** | The Job bypasses the image entrypoint, which is what wires `/opt/bitnami/wordpress/wp-config.php` and `wp-content` to the PVC. Without equivalent mounts, WP-CLI reads the image's template config and writes plugins/uploads into the container layer, where they vanish with the pod | mounts the PVC with the same `subPath` layout (data dir, `wp-config.php`, `wp-content`). Writing symlinks instead fails: `/opt/bitnami/wordpress` is not writable by UID 1001 in a bare pod |

The payment path is verified rather than assumed: the Job asserts that Cash on Delivery is enabled
(and accepts virtual orders when the product is virtual) and exits non-zero otherwise, which turns
into a `Failed` store via the Helm hook instead of a green store with no payment method.

* **Tradeoff:** the Job uses the WordPress image (same UID 1001, same paths) and mounts the
  WordPress PVC, which is `ReadWriteOnce`. On a multi-node cluster the Job pod must land on the
  node holding the volume. Locally (single-node k3s) this is a non-issue; in production the Job
  would need an affinity rule to the WordPress pod's node, or a storage class with `ReadWriteMany`.
* **Tradeoff:** the Job falls back to downloading `wp-cli.phar` if the image lacks WP-CLI, which
  requires outbound HTTPS from the store namespace.

---

## Failure handling and recovery

| Situation | Behaviour | Where |
|---|---|---|
| Crash with a `Pending` row | Provisioned on startup (not stranded) | `reconciliation.service.ts` |
| Crash mid-provision | `Provisioning` row re-enqueued; every step converges | `reconciliation.service.ts` |
| Crash mid-delete | `Deleting` row re-enqueued | `reconciliation.service.ts` |
| Helm release exists | `upgrade --install` reconciles | `helm.service.ts` |
| API dies during a Helm install/upgrade | The release is left in `pending-install`/`pending-upgrade`, and every later `upgrade --install` fails with "another operation is in progress" | `clearStaleHelmOperation()` reads the release phase first: `pending-install` → uninstall the incomplete release; `pending-upgrade`/`pending-rollback` → roll back to the last deployed revision (keeping the store), uninstalling only if none exists |
| Secret exists | Reused, never rotated | `k8s/secrets.ts` |
| Provisioning fails | `Failed` + failing step (+ init Job log tail) | `provisioner.service.ts` |
| Deletion fails | `Failed` + `Deletion failed: …`; another DELETE retries | `provisioner.service.ts` |
| Failed store | Never retried automatically; inspectable until deleted | `reconciliation.service.ts` |

Two decisions worth defending:

* **`Failed` is terminal for both provisioning and deletion failures.** Auto-retrying failures
  forever hides them and burns cluster resources. Recovery is deliberate: delete it (which
  retries cleanup) or investigate it.
* **Deletion confirms, it does not assume.** After `deleteNamespace`, the API polls until the
  namespace is actually gone before removing the database row (`DELETE_TIMEOUT_MS`, default 120s).
  Otherwise the dashboard would report "deleted" while resources were still terminating.
  A namespace stuck on finalizers produces a `Failed` store with an actionable message.
* **Concurrent deletion is guarded.** `setStoreStatus(..., { skipIfDeleting: true })` stops a
  finishing provision from overwriting `Deleting` with `Ready`, and the worker chains per-store
  work so a delete requested mid-provision runs immediately afterwards instead of being dropped.

---

## Cleanup guarantees

Deleting a store removes everything it owns, in an order that cannot orphan resources:

1. `helm uninstall` (skipped when the release is already gone — the common case after a failed
   provisioning run, where deleting the release is the point of the retry).
2. Delete the namespace, which cascades pods, services, ingresses, secrets and claims.
3. **Confirm** the namespace is actually gone (polled until 404, bounded), because namespace
   deletion is asynchronous and can stall on finalizers.
4. Only then remove the database record, so the dashboard can never report a store as deleted
   while its resources are still terminating.

Failure handling is deliberately asymmetric: a failure here sets the store to `Failed` with the
error message, and a repeated `DELETE` (or the next startup) retries the whole sequence — every
step is safe to repeat because a missing release and a missing namespace are both expected states.

**PVC caveat worth stating in a review:** deleting a namespace deletes the claims, but whether the
*underlying volume* is released depends on the StorageClass reclaim policy. `Retain` volumes
survive with their data; `Delete` volumes are destroyed by the provisioner. That is a storage-class
decision, not an application one, and it is the thing to check before promising a customer that a
deletion is irreversible.

## Isolation

| Layer | Implementation |
|---|---|
| Namespace | one per store, `store-<8 hex>` |
| NetworkPolicy | `default-deny-ingress`, `allow-ingress-controller`, `allow-internal`, `allow-platform-ingress` |
| ResourceQuota | 2 CPU / 2 GiB requests, 10 pods, 4 PVCs |
| LimitRange | default 250m CPU / 256Mi memory, default request 50m / 64Mi |
| Credentials | per-store Secret, generated once |
| Data | one MariaDB StatefulSet + PVCs per store |
| Ingress | one host per store (`store-<id>.<STORE_DOMAIN>`) |

**The Bitnami subchart's own NetworkPolicy is set to `allowExternal: false`.** By default it
accepts ingress to the WordPress pods from *any* namespace on the HTTP ports, and because
NetworkPolicies are additive, that default would silently defeat the per-store allow-list above.
Egress stays open (`allowExternalEgress: true`) because WordPress must reach wordpress.org for
plugin installs and updates.

**Enforcement caveat:** Kubernetes does not enforce NetworkPolicy itself — the CNI does. k3s
(both local paths here, and the suggested VPS setup) enforces it; a CNI that ignores NetworkPolicy
would accept these objects and enforce nothing. This repository does not claim enforcement was
measured on your cluster.

**RBAC caveat (least privilege, honestly):** the API's ClusterRole grants namespaced verbs for
the resource types the store charts render — in *every* namespace, not only store namespaces.
That cannot be narrowed with `resourceNames` (create cannot be name-scoped, and store namespaces
do not exist until runtime), and pre-creating a Role per store would require the API to manage
`roles`/`rolebindings` plus `escalate`, which is a larger privilege. What *is* limited: no
wildcards, no RBAC objects, no nodes, no CRDs, and only the kinds the charts actually render.
`npm run check:rbac` renders the store chart, collects every kind it creates and asserts the
ClusterRole covers each one — so the two cannot drift silently.

---

## Secrets and hardening

| Item | Development | Production |
|---|---|---|
| Platform DB password | in `values.yaml`, clearly marked dev-only | operator-created Secret via `postgresql.auth.existingSecret` + `api.databaseUrlSecret` (no password rendered by Helm) |
| Store credentials | generated per store, stored in `store-credentials` | same |
| Credentials in Helm release metadata | never (`--set` carries only the secret name) | same |

Container hardening implemented for the platform: non-root (UID 1000), `readOnlyRootFilesystem`
with an `emptyDir` at `/tmp` (Helm needs writable cache/config/data directories, pointed there by
`HELM_CACHE_HOME`/`HELM_CONFIG_HOME`/`HELM_DATA_HOME`), all capabilities dropped,
`allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`. The `api/Dockerfile` ends with
`USER node`, so docker-compose gets the same treatment rather than only Kubernetes.

* **Deliberately not enabled:** `readOnlyRootFilesystem` for the store pods (Bitnami's entrypoint
  links and writes files at startup) and for the init Job (WP-CLI writes to the PVC).
  A checkbox that breaks the product is worse than an honest omission.

---

## Observability

* Structured pino logs with stable event names (`provisioning_started`, `provisioning_step`,
  `reconciliation_complete`, `namespace_created`, `resource_quota_ensured`,
  `store_credentials_reused`, `helm_upgrade_install_started`, `store_http_probe_attempt`, …).
* Audit trail in PostgreSQL, one row per provisioning/deletion step, which is what the dashboard's
  activity panel renders: a live badge with elapsed time, a pipeline stepper whose stages are
  derived from the recorded steps (so it cannot claim progress that never happened), and a timeline
  where each entry carries the step's own explanation. New entries animate in; history does not
  re-animate on every poll.
* `GET /api/metrics`: totals, counts by status, average provisioning duration, recent failures.
* Failure messages carry the failing step, and init failures carry the init Job's log tail —
  "post-install hooks failed" alone is not an actionable error.

---

## Scaling

| Component | Current | Production evolution |
|---|---|---|
| Dashboard | stateless, scale freely | same |
| API (read paths) | stateless | same |
| API (provisioning) | in-memory queue, **single replica** | shared queue + distributed lease/lock |
| PostgreSQL | single instance | managed/replicated |
| Stores | one namespace + one MariaDB each | same, optionally shared DB tier |

Throughput is limited by Helm and by the cluster (image pulls, volume provisioning), not by the
API process. Concurrency is capped deliberately: unbounded parallel provisioning would overwhelm
a small cluster and make failures harder to attribute.

---

## Upgrade and rollback

Helm keeps release history for both the platform and each store:

```bash
helm history store-<id> -n store-<id>
helm rollback store-<id> 1 -n store-<id>
```

Rolling back the application is not the same as rolling back the data. Image and config changes
roll back cleanly; Prisma migrations do not reverse themselves, so a platform rollback should be
treated as an application-level action with the database handled deliberately. Standing up the
previous version against a migrated schema is normally fine (additive migrations), but that is a
property of the migration, not a guarantee of the rollback.

---

## Local-to-production parity

Everything that differs between local and production is a Helm value:

| Aspect | Local | Production |
|---|---|---|
| Store values file | `HELM_VALUES_PROFILE=local` → `values-local.yaml` | `prod` → `values-prod.yaml` |
| Domain / scheme | `localtest.me`, `http` | `stores.example.com`, `https` |
| Storage class | `local-path` | provider class |
| TLS | off | cert-manager |
| Images | imported into k3d, `pullPolicy: Never` | registry, immutable tag |
| Platform DB credentials | chart-rendered dev secret | operator-created Secret |
| Probe target | `service` (in-cluster) or `ingress` (compose) | `service` |

No application code changes between the two; the only runtime difference is the configuration the
platform chart renders into the ConfigMap (`helm/platform/templates/configmap.yaml` renders
`.Values.api.env` directly, so values and process environment cannot drift).

---

## Deliberately not built

Kafka, Temporal, custom resources, a Kubernetes operator, a service mesh, Argo CD/GitOps, and a
full CI/CD pipeline. They would each add moving parts without changing what this platform has to
prove: correct lifecycle, real isolation, and honest recovery. The design notes above record where
each of them would slot in if the system had to grow — the queue is the first real limit, and it
is documented rather than hidden.
