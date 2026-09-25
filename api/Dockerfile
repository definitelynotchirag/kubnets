# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

# Pinned so a rebuild cannot silently change Helm's behavior (upgrade semantics, --wait).
ARG HELM_VERSION=v3.22.0

RUN apk add --no-cache curl openssl && \
    curl -fsSL -o /tmp/helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" && \
    tar -xzf /tmp/helm.tar.gz -C /tmp && \
    mv /tmp/linux-amd64/helm /usr/local/bin/helm && \
    chmod +x /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz /tmp/linux-amd64 && \
    helm version

WORKDIR /app

# Copy all workspace package.jsons for install
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
COPY dashboard/package.json dashboard/

RUN --mount=type=cache,target=/root/.npm npm ci

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY api/ api/
COPY dashboard/ dashboard/

# Generate the Prisma client before compiling: `@prisma/client` only exports `PrismaClient`
# after generation, and `npm ci` ran before the schema was copied into the image.
RUN cd api && npx prisma generate

# Build shared → api → dashboard
RUN npm run build -w packages/shared && \
    npm run build -w api && \
    npm run build -w dashboard

# --- Production image ---
FROM node:20-alpine

ARG HELM_VERSION=v3.22.0

# curl/openssl are only needed to fetch Helm; they are removed afterwards to keep the runtime
# image small (and to avoid shipping unused network tooling).
RUN apk add --no-cache curl openssl && \
    curl -fsSL -o /tmp/helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" && \
    tar -xzf /tmp/helm.tar.gz -C /tmp && \
    mv /tmp/linux-amd64/helm /usr/local/bin/helm && \
    chmod +x /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz /tmp/linux-amd64 && \
    apk del curl openssl && \
    helm version

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace=@urumi/shared --workspace=@urumi/api

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/api/dist api/dist
COPY --from=builder /app/node_modules/.prisma node_modules/.prisma
COPY api/prisma api/prisma

# Dashboard static build
COPY --from=builder /app/dashboard/dist dashboard/dist

# Helm charts — build dependencies at image build time so the API never needs network access
# to render a store chart.
COPY charts/ charts/
RUN helm dependency build charts/store && \
    helm dependency build charts/medusa-store

ENV NODE_ENV=production
ENV DASHBOARD_PATH=/app/dashboard/dist
# The container runs as the unprivileged `node` user; Helm keeps its cache/config under HOME.
ENV HOME=/home/node
EXPOSE 3001

# Drop root after all build-time work is done (npm ci, helm dependency build). This makes the
# image itself unprivileged, so it is safe in docker-compose too, not only in Kubernetes where
# the pod securityContext already pins the UID.
USER node

# Run migrations then start.
# The CLI is invoked from node_modules directly (not via `npx`) because npx would want to write
# to the npm cache under $HOME, which is not writable with a read-only root filesystem.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema api/prisma/schema.prisma && node api/dist/index.js"]
