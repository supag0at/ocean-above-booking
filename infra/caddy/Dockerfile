# Multi-stage (D-27): build the SPA with MSW off, then serve it from Caddy.
FROM node:24-bookworm-slim AS web

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY services/booking/package.json services/booking/package.json
COPY services/gateway/package.json services/gateway/package.json
COPY services/hands/package.json services/hands/package.json
COPY services/harness/package.json services/harness/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/flight-core/package.json packages/flight-core/package.json
COPY packages/memory/package.json packages/memory/package.json
COPY packages/platform/package.json packages/platform/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/web/index.html apps/web/index.html
COPY apps/web/vite.config.ts apps/web/vite.config.ts
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY apps/web/src apps/web/src
COPY packages/contracts/src packages/contracts/src

# Hard-coded: an unset VITE_MOCK makes the SPA start MSW and never call the gateway.
ENV VITE_MOCK=0
RUN pnpm --filter @fb/web build

FROM caddy:2-alpine

# This tag's default user is root; the image has no `caddy` account.
RUN apk add --no-cache wget
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /src/apps/web/dist /srv
