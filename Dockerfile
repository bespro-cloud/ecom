# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# API image
#
# This lives at the repository root rather than under infrastructure/docker/
# because most hosted platforms look for `./Dockerfile` by default and give a
# bare "no such file or directory" when it is missing. The worker and web
# images stay under infrastructure/docker/ — they are always built with an
# explicit -f.
#
# Multi-stage: the toolchain, sources and dev dependencies stay in the builder;
# the runtime layer carries only what is needed to run. The result runs as an
# unprivileged user with no shell-accessible build tooling.
# ---------------------------------------------------------------------------

FROM node:22.13-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Prisma's query engine needs OpenSSL; the slim image does not ship it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
# The corepack bundled with node:22.13 carries a snapshot of the npm registry's
# signing keys, and those keys have since rotated — it then rejects the
# signature on its own pnpm download and dies with "Cannot find matching
# keyid". Installing a current corepack picks up the new key set. Which pnpm is
# used stays pinned by the root package.json's packageManager field.
RUN npm install --global corepack@latest && corepack enable

# --- dependencies ----------------------------------------------------------
FROM base AS deps
WORKDIR /app
# pnpm asks before purging a modules directory and aborts when no terminal is
# attached, which is every container build (ERR_PNPM_ABORTED_REMOVE_MODULES_-
# DIR_NO_TTY). Set on deps rather than base so it is inherited by the build
# stage but never reaches the runtime layer — CI=true changes how some
# libraries behave, and the shipped container is not a CI environment.
ENV CI=true
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

# Every workspace manifest, because `--frozen-lockfile` compares the lockfile
# against the set of projects it can actually see. A package missing here fails
# the install with ERR_PNPM_OUTDATED_LOCKFILE, which reads like a stale lockfile
# and is not — it is this list being out of date.
#
# KEEP IN SYNC WITH packages/ AND apps/. Adding a workspace package and not
# adding it here breaks the image build and nothing else, so it is easy to miss
# until a deploy.
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/storefront/package.json apps/storefront/
COPY apps/admin/package.json apps/admin/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY packages/auth/package.json packages/auth/
COPY packages/validation/package.json packages/validation/
COPY packages/database/package.json packages/database/
COPY packages/notifications/package.json packages/notifications/
COPY packages/payments/package.json packages/payments/
COPY packages/storage/package.json packages/storage/
COPY packages/ai/package.json packages/ai/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- build -----------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
# `--filter "./packages/*"` rather than an enumerated list: the enumerated form
# silently skipped packages/payments, packages/storage and packages/ai when
# those were added, and the API imports all three. This matches what CI builds.
RUN pnpm --filter @health/database run generate \
 && pnpm --filter "./packages/*" run build \
 && pnpm --filter @health/api run build
# Drop dev dependencies before they are copied into the runtime layer.
RUN pnpm prune --prod

# --- runtime ---------------------------------------------------------------
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# A container that cannot write outside /tmp is one less thing to reason about
# during an incident.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=app:app /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=app:app /app/packages ./packages
COPY --from=build --chown=app:app /app/prisma ./prisma

USER app
EXPOSE 4000

# The orchestrator's own probe should be authoritative, but a HEALTHCHECK makes
# `docker ps` honest for anyone debugging locally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init reaps zombies and forwards SIGTERM, so graceful shutdown works.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
