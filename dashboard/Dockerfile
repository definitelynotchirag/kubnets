# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY dashboard/package.json dashboard/

RUN --mount=type=cache,target=/root/.npm npm ci --workspace=@urumi/shared --workspace=@urumi/dashboard

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY dashboard/ dashboard/

RUN npm run build -w packages/shared && npm run build -w dashboard

FROM node:20-alpine

RUN npm install -g serve@14

WORKDIR /app
COPY --from=builder /app/dashboard/dist ./dist

# Port 8080 (not 80) so the server can run as an unprivileged user.
EXPOSE 8080

USER node

CMD ["serve", "-s", "dist", "-l", "8080"]
