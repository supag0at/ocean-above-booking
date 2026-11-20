# Shared runtime image for gateway, hands, booking, harness and migrate.
# Node 24 runs the existing .ts entries. Dependency lifecycle scripts stay disabled (H-09).
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate

WORKDIR /app

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

# Copy sources only. A full directory copy would replace the pnpm symlinks in node_modules.
COPY services/gateway/src services/gateway/src
COPY services/hands/src services/hands/src
COPY services/booking/src services/booking/src
COPY services/harness/src services/harness/src
COPY packages/contracts/src packages/contracts/src
COPY packages/platform/src packages/platform/src
COPY packages/flight-core/src packages/flight-core/src
COPY packages/memory/src packages/memory/src
COPY infra/db infra/db
COPY infra/compose/ready.mjs infra/compose/ready.mjs

USER 1000:1000
