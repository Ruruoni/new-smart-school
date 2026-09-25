# SmartSchool — one Dockerfile for both apps.
#   docker build -f deploy/Dockerfile --build-arg APP=school -t smartschool/school .
#   docker build -f deploy/Dockerfile --build-arg APP=cloud  -t smartschool/cloud  .
# The image contains the built workspace including dev dependencies, because the same image also runs the
# school worker (tsx), the migrations (prisma) and the operator CLI. It favours "runs the same everywhere" over size.
FROM node:24-bookworm-slim AS build
ARG APP=school
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Dependencies first, from the manifests only: a source-only change reuses this (slow) layer instead of reinstalling.
# --filter installs just this app and the shared protocol package, so the cloud image doesn't carry the school app's dependencies.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/school/package.json ./apps/school/
COPY apps/cloud/package.json ./apps/cloud/
RUN pnpm install --frozen-lockfile --filter "@smartschool/${APP}..."
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
COPY deploy/preflight.mjs ./apps/${APP}/preflight.mjs
# `next build` evaluates route modules, so it needs *some* configuration. These placeholders are set for this one command only
# (not as image ENV, so no secret-looking values are baked into a layer); the real values come from the environment at run time.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build CLOUD_DATABASE_URL=postgresql://build:build@localhost:5432/build \
    APP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= APP_SIGNING_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    CLOUD_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= CLOUD_SIGNING_PRIVATE_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA CLOUD_SIGNING_PUBLIC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    sh -c 'pnpm --filter @smartschool/${APP} exec prisma generate && pnpm --filter @smartschool/${APP} exec next build'

FROM node:24-bookworm-slim AS runtime
ARG APP=school
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP=${APP}
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 smartschool
WORKDIR /app
COPY --from=build --chown=smartschool:smartschool /app /app
RUN mkdir -p /data && chown smartschool:smartschool /data
COPY --chmod=755 deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER smartschool
# pnpm is downloaded by Corepack the first time it runs — which, without this line, would be at CONTAINER START, and fail (or hang)
# on a school server with no internet. Fetch it now, at build time, so the running image never needs the network. (The main
# processes below don't use pnpm at all; this is for operators who run `pnpm exec …` inside the container.)
# (pnpm 12 is a launcher: `prepare` caches the launcher, and the native binary is only fetched the first time pnpm RUNS — so run it once now.)
RUN corepack prepare pnpm@12.4.1 --activate && pnpm --version
WORKDIR /app/apps/${APP}
EXPOSE 3000
# Uploaded files and backups live under /data — mount a volume there (compose does). Without one, Docker still keeps an anonymous
# volume for it, so data survives `docker stop/start` and container re-creation, instead of vanishing inside the container's layer.
# Defaults; every one can be overridden with -e.
ENV STORAGE_DIR=/data/storage BACKUP_DIR=/data/backups BACKUP_STORAGE_DIR=/data/backups
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
# Default: the web app, started directly (no package-manager download, no shell). The entrypoint first runs the preflight
# (configuration check, wait for PostgreSQL, apply migrations); compose overrides the command for the worker and the migration job.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
# Healthy only if configuration, database AND schema are all fine (see /api/health) — a `docker run` user gets a truthful status too.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
