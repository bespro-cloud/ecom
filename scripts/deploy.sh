#!/usr/bin/env bash
#
# Deploys a previously built, immutable image tag to an environment.
#
# Usage: deploy.sh <environment> <image-tag> [--skip-migrations]
#
# Ordering is deliberate:
#   1. Pull the images first, so a registry problem fails before anything on the
#      host has changed.
#   2. Run migrations before the new code starts. The version currently serving
#      must keep working against the new schema, which is why every migration is
#      written to be backward compatible (see docs/deployment/DEPLOYMENT.md).
#   3. Roll services one at a time, waiting for health between each.

set -euo pipefail

ENVIRONMENT="${1:?usage: deploy.sh <environment> <image-tag> [--skip-migrations]}"
IMAGE_TAG="${2:?usage: deploy.sh <environment> <image-tag> [--skip-migrations]}"
SKIP_MIGRATIONS="${3:-}"

: "${DEPLOY_HOST:?DEPLOY_HOST must be set}"
: "${DEPLOY_KEY:?DEPLOY_KEY must be set}"

REMOTE_DIR="/opt/health-commerce"

echo "==> Deploying ${IMAGE_TAG} to ${ENVIRONMENT}"

KEY_FILE="$(mktemp)"
# The key must not be readable by anyone else, and must not survive the run.
chmod 600 "${KEY_FILE}"
printf '%s' "${DEPLOY_KEY}" > "${KEY_FILE}"
trap 'shred -u "${KEY_FILE}" 2>/dev/null || rm -f "${KEY_FILE}"' EXIT

remote() {
  ssh -i "${KEY_FILE}" \
      -o StrictHostKeyChecking=accept-new \
      -o ConnectTimeout=15 \
      "${DEPLOY_HOST}" "$@"
}

echo "--> Pulling images"
remote "cd ${REMOTE_DIR} && IMAGE_TAG=${IMAGE_TAG} docker compose -f docker-compose.yml -f docker-compose.prod.yml pull"

if [[ "${SKIP_MIGRATIONS}" != "--skip-migrations" ]]; then
  echo "--> Applying database migrations"
  # A one-off container running the new image, so migrations always match the
  # code about to start.
  remote "cd ${REMOTE_DIR} && IMAGE_TAG=${IMAGE_TAG} docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma"

  echo "--> Syncing reference data (roles, permissions, settings)"
  # Idempotent and safe on every deploy: it creates no accounts.
  remote "cd ${REMOTE_DIR} && IMAGE_TAG=${IMAGE_TAG} docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api node packages/database/dist/seed/rbac-only.js"
else
  echo "--> Skipping migrations (rollback)"
fi

echo "--> Rolling services"
for service in api worker storefront admin; do
  echo "    ${service}"
  remote "cd ${REMOTE_DIR} && IMAGE_TAG=${IMAGE_TAG} docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --wait ${service}"
done

echo "--> Reloading nginx"
remote "cd ${REMOTE_DIR} && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T nginx nginx -t && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T nginx nginx -s reload"

echo "--> Recording the deployed tag"
remote "echo ${IMAGE_TAG} > ${REMOTE_DIR}/.deployed-tag"

echo "==> ${ENVIRONMENT} is now running ${IMAGE_TAG}"
