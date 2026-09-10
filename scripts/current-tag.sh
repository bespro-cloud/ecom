#!/usr/bin/env bash
#
# Reads the tag currently deployed to a host, so a failed deploy can roll back
# to a known-good version rather than to a guess.

set -euo pipefail

: "${DEPLOY_HOST:?DEPLOY_HOST must be set}"
: "${DEPLOY_KEY:?DEPLOY_KEY must be set}"

KEY_FILE="$(mktemp)"
chmod 600 "${KEY_FILE}"
printf '%s' "${DEPLOY_KEY}" > "${KEY_FILE}"
trap 'shred -u "${KEY_FILE}" 2>/dev/null || rm -f "${KEY_FILE}"' EXIT

tag="$(ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
  "${DEPLOY_HOST}" 'cat /opt/health-commerce/.deployed-tag 2>/dev/null || true')"

echo "tag=${tag}"
