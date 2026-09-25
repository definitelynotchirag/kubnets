FROM node:20-alpine AS builder

RUN apk add --no-cache curl openssl && \
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sh

WORKDIR /app

# Copy all workspace package.jsons for install
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
COPY dashboard/package.json dashboard/

RUN npm ci

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY api/ api/
COPY dashboard/ dashboard/

# Build shared → api → dashboard
RUN npm run build -w packages/shared && \
    npm run build -w api && \
    npm run build -w dashboard

# Generate Prisma client
RUN cd api && npx prisma generate

# --- Production image ---
FROM node:20-alpine

RUN apk add --no-cache curl openssl && \
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sh && \
    apk del curl openssl

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/

RUN npm ci --omit=dev --workspace=@urumi/shared --workspace=@urumi/api

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/api/dist api/dist
COPY --from=builder /app/node_modules/.prisma node_modules/.prisma
COPY api/prisma api/prisma

# Dashboard static build
COPY --from=builder /app/dashboard/dist dashboard/dist

# Helm charts — build dependencies at image build time
COPY charts/ charts/
RUN helm dependency build charts/store && \
    helm dependency build charts/medusa-store

ENV NODE_ENV=production
ENV DASHBOARD_PATH=/app/dashboard/dist
EXPOSE 3001

# Run migrations then start
CMD ["sh", "-c", "cd api && npx prisma migrate deploy && cd .. && node api/dist/index.js"]
