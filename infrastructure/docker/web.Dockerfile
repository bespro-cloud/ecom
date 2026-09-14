# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Next.js image, shared by the storefront and the admin console.
#
# Build with:  --build-arg APP=storefront   (or admin)
#              --build-arg PORT=3000        (or 3001)
#
# Uses Next's standalone output, so the runtime layer contains only the traced
# server files rather than the whole node_modules tree.
# ---------------------------------------------------------------------------

ARG APP=storefront
ARG PORT=3000

FROM node:22.13-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
# See the root Dockerfile: node:22.13's bundled corepack has stale npm registry
# signing keys and rejects its own pnpm download.
RUN npm install --global corepack@latest && corepack enable

FROM base AS deps
WORKDIR /app
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

FROM deps AS build
ARG APP
WORKDIR /app
COPY . .
# The storefront and admin consume some workspace packages as TypeScript
# directly (transpilePackages), but others — @health/types among them — are
# compiled and imported as packages. Building all of them is both simpler and
# proof against the next package that turns out to need compiling.
RUN pnpm --filter "./packages/*" run build
# Public URLs are baked into the client bundle at build time; anything secret
# must never be a NEXT_PUBLIC_* value.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SITE_NAME
ARG NEXT_PUBLIC_ADMIN_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter "@health/${APP}" run build

FROM base AS runtime
ARG APP
ARG PORT
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=${PORT}
ENV HOSTNAME=0.0.0.0

RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin app

COPY --from=build --chown=app:app /app/apps/${APP}/.next/standalone ./
COPY --from=build --chown=app:app /app/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=build --chown=app:app /app/apps/${APP}/public ./apps/${APP}/public

USER app
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENV APP_DIR=apps/${APP}
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node ${APP_DIR}/server.js"]
