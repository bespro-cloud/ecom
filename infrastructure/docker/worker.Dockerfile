# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Worker image
#
# Runs the outbox dispatcher, the BullMQ processors and the scheduled
# maintenance jobs. It serves HTTP only for its health endpoints, which are
# never exposed publicly. Same build strategy as the API image at the
# repository root.
# ---------------------------------------------------------------------------

FROM node:22.13-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Prisma's query engine needs OpenSSL; the slim image does not ship it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
# See the root Dockerfile: node:22.13's bundled corepack has stale npm registry
# signing keys and rejects its own pnpm download.
RUN npm install --global corepack@latest && corepack enable

# --- dependencies ----------------------------------------------------------
FROM base AS deps
WORKDIR /app
# See the root Dockerfile: pnpm aborts a modules purge when no terminal is
# attached. Kept off the runtime layer deliberately.
ENV CI=true
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

# Every workspace manifest — see the note in the root Dockerfile. A package
# missing here fails the install with ERR_PNPM_OUTDATED_LOCKFILE.
# KEEP IN SYNC WITH packages/ AND apps/.
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
RUN pnpm --filter @health/database run generate \
 && pnpm --filter "./packages/*" run build \
 && pnpm --filter @health/worker run build

# No `pnpm prune --prod` — see the note in the root Dockerfile. At a workspace
# root it prunes against a manifest that declares no dependencies and takes the
# runtime modules with it.

# --- runtime ---------------------------------------------------------------
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# A container that cannot write outside /tmp is one less thing to reason about
# during an incident.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build --chown=app:app /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=app:app /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=app:app /app/packages ./packages
COPY --from=build --chown=app:app /app/prisma ./prisma

USER app
EXPOSE 4100

# The orchestrator's own probe should be authoritative, but a HEALTHCHECK makes
# `docker ps` honest for anyone debugging locally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||4100)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init reaps zombies and forwards SIGTERM, so graceful shutdown works.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/worker/dist/main.js"]
