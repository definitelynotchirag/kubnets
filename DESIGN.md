# System Design & Tradeoffs

## Architecture Choices

### Why Helm + `execa` (not a JS Helm SDK)
No reliable JavaScript Helm SDK exists. Shelling out to the `helm` CLI via `execa` is the standard industry approach (used by ArgoCD, Flux, Rancher). The `--wait` flag handles readiness polling natively.

### Why `p-limit(3)` in-memory queue (not Redis/RabbitMQ)
For a single-instance API, an in-memory concurrency limiter is sufficient. On startup, the API reconciles stale stores stuck in `Provisioning` or `Deleting` by re-enqueuing them. This handles crash recovery without external infrastructure.

**Tradeoff:** Not suitable for multi-replica API. For horizontal scaling, replace with a Redis-backed job queue (BullMQ) or a Kubernetes Job-based approach.

### Why Prisma ORM
Type-safe queries with auto-generated client. Single schema file is the source of truth for DB types. Auto-migrations simplify deployment.

### Why bundled MariaDB per store
Maximum isolation — each store has its own database in its own namespace. No shared infrastructure means one store's failure can't affect others. PVCs ensure data persistence.

**Tradeoff:** Higher resource usage vs. a shared database. For cost optimization at scale, consider a shared PostgreSQL with per-store databases.

### Why namespace-per-store
Kubernetes namespaces provide natural isolation boundaries for:
- RBAC scoping
- NetworkPolicy enforcement
- ResourceQuota/LimitRange enforcement
- Clean teardown (delete namespace cascades everything)

## Isolation & Resources

### Per-store resources
| Resource | Quota |
|----------|-------|
| CPU requests | 2 cores total |
| Memory requests | 2Gi total |
| Pods | 10 max |
| PVCs | 4 max |
| LimitRange default | 250m CPU, 256Mi memory per container |

### Network isolation
Each namespace gets three NetworkPolicies:
1. **default-deny-ingress** — Block all incoming traffic by default
2. **allow-ingress-controller** — Allow traffic from `ingress-nginx` namespace only
3. **allow-internal** — Allow pods within the same namespace to communicate (WordPress ↔ MariaDB)

## Idempotency & Failure Handling

### Store creation is idempotent
- Namespace creation checks if it already exists before creating
- Helm `install` fails gracefully if release exists
- Network policies and secrets are created only if not present

### Crash recovery
On API startup, `reconcileStaleStores()` finds all stores stuck in:
- `Provisioning` → Re-enqueues for provisioning
- `Deleting` → Re-enqueues for deletion

This ensures the system self-heals after a crash during a long-running operation.

### Clean failure states
If provisioning fails at any step, the store is marked `Failed` with the error message stored. The partially-created K8s resources remain for debugging. A user can delete the failed store to trigger full cleanup.

## Cleanup Guarantees

Store deletion follows a strict order:
1. Mark store as `Deleting` in DB (prevents re-deletion)
2. `helm uninstall` — removes all Helm-managed resources
3. `kubectl delete namespace` — cascades remaining resources (PVCs, secrets, etc.)
4. Delete store record from DB

If any step fails, the store is marked `Failed` with the error, allowing retry.

## Abuse Prevention

| Control | Implementation |
|---------|---------------|
| Global rate limit | 100 req/min per IP |
| Store creation rate limit | 5/min per IP |
| Max stores | 5 total (configurable) |
| Provisioning timeout | 10 min via `helm --timeout` |
| ResourceQuota per store | Caps CPU, memory, pods, PVCs |
| Audit log | All create/delete/status changes logged with IP |

## Observability

- **Structured logging**: Pino with JSON output (pretty-print in dev)
- **Audit trail**: Every store lifecycle event logged with timestamp, action, IP address
- **Metrics endpoint**: `/api/metrics` returns store counts by status, avg provisioning duration, recent failures
- **Activity log in dashboard**: Per-store event timeline visible on detail page
- **Error reporting**: Failed stores show full error message in dashboard

## Horizontal Scaling Plan

### What scales horizontally
| Component | Strategy |
|-----------|----------|
| Dashboard | Stateless — scale replicas |
| API (read operations) | Stateless — scale replicas behind load balancer |
| API (provisioning) | Requires distributed locking or queue |

### Provisioning throughput
Current: `p-limit(3)` caps at 3 concurrent provisions per API instance.

To scale:
1. Replace `p-limit` with **BullMQ** (Redis-backed) — multiple API instances share the queue
2. Or use **Kubernetes Jobs** — the API creates a Job per store, K8s handles scheduling and concurrency
3. Configure `MAX_CONCURRENT_PROVISIONS` via Helm values

### Stateful constraints
- PostgreSQL: Single instance. For HA, use Bitnami PostgreSQL with replication or a managed service.
- Helm operations: Each `helm install` acquires a release lock per namespace, so concurrent provisions to different stores are safe.

## Upgrade & Rollback Story

### Store upgrades
```bash
# Update chart version in Chart.yaml, then:
helm upgrade store-<id> ./charts/store \
  -n store-<id> \
  -f charts/store/values-local.yaml \
  --wait --timeout 10m

# Rollback if something breaks:
helm rollback store-<id> -n store-<id>
```

### Platform upgrades
```bash
# Rebuild images, then:
helm upgrade urumi ./helm/platform \
  -f helm/platform/values-prod.yaml \
  --wait

# Rollback:
helm rollback urumi
```

Helm maintains revision history by default. `helm history <release>` shows all past versions.

## Local-to-VPS Production Changes

All differences are in Helm values files. No code changes needed.

| Aspect | Local (`values-local.yaml`) | Production (`values-prod.yaml`) |
|--------|---------------------------|--------------------------------|
| StorageClass | `local-path` | Cloud provider (e.g., `longhorn`, `gp3`) |
| Ingress TLS | Disabled | Enabled via cert-manager |
| Domain | `*.localtest.me` | `*.yourdomain.com` |
| Resources | 256-512Mi memory | 512Mi-1Gi memory |
| Image pull | `IfNotPresent` | `Always` or pinned digests |
| Secrets | Random (auto-generated) | External secrets (Vault, SOPS) |

### DNS for production
1. Set up a wildcard DNS record: `*.stores.yourdomain.com → VPS IP`
2. Install cert-manager for automatic TLS:
   ```bash
   helm install cert-manager jetstack/cert-manager --set installCRDs=true
   ```
3. Configure `values-prod.yaml` with the cluster issuer

### Storage for production
- Use Longhorn (built into k3s) or a cloud StorageClass
- Enable backup/snapshot policies for store PVCs
- Consider separate StorageClass for database vs. WordPress files

## Engine Extensibility

The system is designed to support multiple ecommerce engines:

1. **Shared types**: `StoreEngine = "woocommerce" | "medusa"` in `@urumi/shared`
2. **Engine-specific charts**: `charts/store/` for WooCommerce, `charts/medusa-store/` for Medusa
3. **Helm service routing**: `getChartPath(engine)` selects the right chart
4. **Engine-specific `--set` args**: `getEngineSetArgs(engine, ...)` configures each engine differently

Adding a new engine requires:
1. Create a new Helm chart in `charts/`
2. Add the engine to the `StoreEngine` type and Zod schema
3. Add routing in `helm.service.ts` (`getChartPath` + `getEngineSetArgs`)
4. Build chart dependencies in the Dockerfile
