#!/usr/bin/env bash
#
# One-command local setup.
#
# Brings up PostgreSQL, Redis and MinIO, applies migrations, seeds development
# data, then starts every app in watch mode.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
  echo "    Generating development key material"
  SESSION_SECRET="$(openssl rand -base64 32)"
  ENCRYPTION_KEY="$(openssl rand -base64 32)"
  # Development-only values. Production keys come from the secret manager.
  sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" .env
  sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${ENCRYPTION_KEY}|" .env
  rm -f .env.bak
fi

echo "==> Starting infrastructure"
docker compose up -d postgres redis minio

echo "==> Waiting for PostgreSQL"
until docker compose exec -T postgres pg_isready -q; do sleep 1; done

echo "==> Installing dependencies"
pnpm install

echo "==> Generating the Prisma client"
pnpm --filter @health/database run generate

echo "==> Building shared packages"
pnpm --filter "./packages/*" run build

echo "==> Applying migrations"
pnpm run db:migrate:deploy

echo "==> Seeding development data"
pnpm run db:seed

echo
echo "==> Ready. Starting all apps in watch mode."
echo "    Storefront  http://localhost:3000"
echo "    Admin       http://localhost:3001"
echo "    API docs    http://localhost:4000/api/docs"
echo
pnpm run dev
