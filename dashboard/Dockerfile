FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY dashboard/package.json dashboard/

RUN npm ci --workspace=@urumi/shared --workspace=@urumi/dashboard

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY dashboard/ dashboard/

RUN npm run build -w packages/shared && npm run build -w dashboard

FROM node:20-alpine

RUN npm install -g serve@14

WORKDIR /app
COPY --from=builder /app/dashboard/dist ./dist

EXPOSE 80

CMD ["serve", "-s", "dist", "-l", "80"]
