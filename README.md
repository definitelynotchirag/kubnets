# Kubnets — Multi-Tenant Store Provisioning Platform

A Kubernetes-native platform that dynamically provisions isolated ecommerce stores (WooCommerce / MedusaJS). Each store runs in its own namespace with full resource isolation, network policies, and Helm-based lifecycle management.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Dashboard (React)              │
│              localhost:3001 (served by API)       │
└────────────────────┬────────────────────────────┘
                     │ /api/*
┌────────────────────▼────────────────────────────┐
│                  API (Express + TypeScript)       │
│  ┌──────────┐ ┌───────────┐ ┌────────────────┐  │
│  │  Routes   │ │  Store    │ │  Provisioner   │  │
│  │  + Rate   │ │  Service  │ │  Worker        │  │
│  │  Limiting │ │  + Audit  │ │  (p-limit=3)   │  │
│  └──────────┘ └───────────┘ └───────┬────────┘  │
│                                      │           │
│  ┌──────────┐  ┌─────────────────────▼────────┐  │
│  │ Prisma   │  │  K8s Client + Helm CLI       │  │
│  │ (PgSQL)  │  │  (namespace, secrets, netpol) │  │
│  └──────────┘  └─────────────────────┬────────┘  │
└──────────────────────────────────────┼──────────┘
                                       │
┌──────────────────────────────────────▼──────────┐
│              Kubernetes (k3s)                    │
│  ┌─────────────────┐  ┌─────────────────────┐   │
│  │ store-abc123     │  │ store-def456         │   │
│  │ ┌─────────────┐ │  │ ┌─────────────────┐ │   │
│  │ │ WordPress   │ │  │ │ WordPress       │ │   │
│  │ │ + WooComm   │ │  │ │ + WooCommerce   │ │   │
│  │ ├─────────────┤ │  │ ├─────────────────┤ │   │
│  │ │ MariaDB     │ │  │ │ MariaDB         │ │   │
│  │ ├─────────────┤ │  │ ├─────────────────┤ │   │
│  │ │ NetworkPol  │ │  │ │ NetworkPolicy   │ │   │
│  │ │ ResQuota    │ │  │ │ ResourceQuota   │ │   │
│  │ │ LimitRange  │ │  │ │ LimitRange      │ │   │
│  │ └─────────────┘ │  │ └─────────────────┘ │   │
│  └─────────────────┘  └─────────────────────┘   │
└──────────────────────────────────────────────────┘
```

## Quick Start (Local — Docker Compose)

**Prerequisites:** Docker with Docker Compose.

```bash
# Clone and start everything
git clone <repo-url> && cd urumi
docker compose -f docker-compose.dev.yaml up -d --build

# Watch logs (first run takes ~3-5 minutes for k3s + ingress)
docker compose -f docker-compose.dev.yaml logs -f
```

**Once running:**
- Dashboard + API: http://localhost:3001
- Store URLs: http://store-{id}.localtest.me (resolved via k3s ingress on port 80)

### Create a store and place an order

1. Open http://localhost:3001
2. Click **"+ New Store"** → select **WooCommerce** → **Create**
3. Wait for status to change from Provisioning → **Ready** (~3-5 min)
4. Click the store URL (e.g., `http://store-abc123.localtest.me`)
5. Navigate to **Shop** → add product to cart → **Checkout** → fill details → place order (COD)
6. Verify order in WP Admin: `http://store-abc123.localtest.me/wp-admin` (user: `admin`, password in K8s secret)

### Get WordPress admin password

```bash
docker compose -f docker-compose.dev.yaml exec k3s \
  kubectl get secret -n store-<id> store-<id>-wordpress \
  -o jsonpath='{.data.wordpress-password}' | base64 -d
```

### Delete a store

Click the trash icon in the dashboard. All K8s resources (namespace, PVCs, secrets, pods) are cleaned up.

### Tear down

```bash
docker compose -f docker-compose.dev.yaml down -v
```

## VPS / Production Setup (k3s)

The same Helm charts deploy to a VPS running k3s. What changes via values:

| Setting | Local | Production |
|---------|-------|------------|
| `HELM_VALUES_PROFILE` | `local` | `prod` |
| `STORE_DOMAIN` | `localtest.me` | `yourdomain.com` |
| StorageClass | `local-path` | cloud provider / longhorn |
| Ingress TLS | disabled | enabled (cert-manager) |
| Resources | minimal (256-512Mi) | larger (512Mi-1Gi) |

```bash
# On VPS with k3s installed:
helm install urumi ./helm/platform \
  -f helm/platform/values-prod.yaml \
  --set api.env.STORE_DOMAIN=yourdomain.com \
  --set ingress.host=urumi.yourdomain.com
```

See [DESIGN.md](./DESIGN.md) for full production deployment guide.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/stores` | List all stores |
| `POST` | `/api/stores` | Create store `{engine: "woocommerce"\|"medusa"}` |
| `GET` | `/api/stores/:id` | Get store details |
| `DELETE` | `/api/stores/:id` | Delete store |
| `GET` | `/api/stores/:id/logs` | Store activity log |
| `GET` | `/api/audit-logs` | Global audit log |
| `GET` | `/api/metrics` | Platform metrics |

## Project Structure

```
urumi/
├── packages/shared/        # @urumi/shared — types + Zod schemas
├── api/                    # Express API + provisioner
│   ├── src/
│   │   ├── k8s/            # K8s operations (namespace, netpol, secrets)
│   │   ├── services/       # Store, provisioner, helm, audit, metrics
│   │   ├── workers/        # Provisioning queue (p-limit concurrency)
│   │   ├── middleware/      # Validation, rate limiting, error handler
│   │   └── routes/         # Express routes
│   └── prisma/             # Schema + migrations
├── dashboard/              # React + TanStack Query + Tailwind
├── charts/
│   ├── store/              # WooCommerce store chart (wraps bitnami/wordpress)
│   └── medusa-store/       # MedusaJS store chart (stub)
├── helm/platform/          # Platform chart (API + Dashboard + PostgreSQL)
├── scripts/                # Setup, teardown, test scripts
└── docker-compose.dev.yaml # Full local dev environment
```

## Security

- **Namespace isolation**: Each store in its own namespace
- **NetworkPolicies**: Default-deny ingress per namespace, allow only ingress-nginx + intra-namespace
- **ResourceQuota + LimitRange**: Per-namespace resource caps (2 CPU, 2Gi memory, 10 pods, 4 PVCs)
- **RBAC**: Platform API runs with least-privilege ClusterRole
- **Secrets**: Random credentials per store, never in source code
- **Rate limiting**: 100 req/min global, 5 store creations/min per IP
- **Container hardening**: Bitnami images run as non-root with read-only root filesystem
