#!/usr/bin/env bash
#
# Takes a database backup immediately before a production deploy.
#
# The deploy does not proceed if this fails. A migration without a restorable
# backup is not a deployment, it is a gamble.

set -euo pipefail

: "${DEPLOY_HOST:?DEPLOY_HOST must be set}"
: "${DEPLOY_KEY:?DEPLOY_KEY must be set}"

REMOTE_DIR="/opt/health-commerce"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

KEY_FILE="$(mktemp)"
chmod 600 "${KEY_FILE}"
printf '%s' "${DEPLOY_KEY}" > "${KEY_FILE}"
trap 'shred -u "${KEY_FILE}" 2>/dev/null || rm -f "${KEY_FILE}"' EXIT

echo "==> Taking a pre-deploy backup (${STAMP})"

ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
  "${DEPLOY_HOST}" "cd ${REMOTE_DIR} && ./scripts/backup.sh pre-deploy-${STAMP}"

echo "==> Backup complete"
