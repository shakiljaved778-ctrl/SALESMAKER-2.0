# syntax=docker/dockerfile:1.7
# Server images for the cell and control plane (§3.1, docs/runbooks/deploy.md). One file, one app
# per build: --build-arg APP=api|worker|control-api. The web app deploys to Vercel (ADR-0003).
#
#   docker buildx build -f infra/docker/app/Dockerfile --build-arg APP=api --target app .
#   docker buildx build -f infra/docker/app/Dockerfile --target migrate .
ARG NODE_IMAGE=node:24-bookworm-slim
# Prisma's schema engine needs libssl, which the full image has (the app images do not need it:
# the Prisma 7 client runs without an engine).
ARG MIGRATE_IMAGE=node:24-bookworm

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ── Build one app and the workspace packages it depends on ─────────────────────────────
FROM base AS build
ARG APP
RUN test -n "$APP" || (echo "--build-arg APP=api|worker|control-api is required" && exit 1)
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@sm/${APP}..."
# Loose env mode: the build sees the image's environment (proxies, CA bundles on build hosts).
RUN pnpm turbo run build --env-mode=loose --filter="@sm/${APP}..."
# Keep production dependencies only, for this app and its workspace packages.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && pnpm install --frozen-lockfile --prod --filter "@sm/${APP}..." \
    && rm -rf apps/web packages/ui .turbo \
    && find apps packages -maxdepth 2 \( -name src -o -name test -o -name e2e \) -type d -prune -exec rm -rf {} + 2>/dev/null; true

# ── Runtime: no shell tooling beyond the base, non-root, read-only root filesystem in ECS ──
FROM ${NODE_IMAGE} AS app
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo /app
WORKDIR /app/apps/${APP}
USER node
CMD ["node", "dist/main.js"]

# ── Migrations: one-off task per deploy (expand-only, §11.3) ───────────────────────────
FROM ${MIGRATE_IMAGE} AS migrate
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@sm/db" --filter "@sm/control-api"
# Fetch the schema engine now: the task's root filesystem is read-only.
RUN cd packages/db && pnpm exec prisma version
COPY infra/docker/app/migrate.sh /usr/local/bin/sm-migrate
USER node
ENTRYPOINT ["sm-migrate"]
