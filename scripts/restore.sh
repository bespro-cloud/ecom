#!/usr/bin/env bash
#
# Restores an encrypted backup.
#
# Restores into a NEW database by default and never over the live one: the
# common case is "we need yesterday's data", not "destroy today's". Promoting a
# restored database is a separate, deliberate step.
#
# Usage: restore.sh <backup-name> [target-database]

set -euo pipefail

BACKUP_NAME="${1:?usage: restore.sh <backup-name> [target-database]}"
TARGET_DB="${2:-health_commerce_restore_$(date -u +%Y%m%d%H%M%S)}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY must point at the age private key file}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"

if [[ "${TARGET_DB}" == "${POSTGRES_DB:-health_commerce}" ]]; then
  echo "==> Refusing to restore over the live database." >&2
  echo "    Restore to a new database, verify it, then promote deliberately." >&2
  exit 1
fi

echo "==> Downloading ${BACKUP_NAME}"
aws s3 cp "s3://${BACKUP_S3_BUCKET}/postgres/${BACKUP_NAME}.dump.age" "${WORK_DIR}/backup.dump.age"

echo "==> Decrypting"
age --decrypt --identity "${BACKUP_AGE_IDENTITY}" \
    --output "${WORK_DIR}/backup.dump" \
    "${WORK_DIR}/backup.dump.age"

echo "==> Creating ${TARGET_DB}"
docker compose exec -T postgres createdb --username "${POSTGRES_USER}" "${TARGET_DB}"

echo "==> Restoring"
docker compose exec -T postgres pg_restore \
  --username "${POSTGRES_USER}" \
  --dbname "${TARGET_DB}" \
  --no-owner \
  --no-privileges \
  --jobs 4 \
  < "${WORK_DIR}/backup.dump"

echo "==> Verifying the restore"
# A restore that produced an empty schema is a failure, whatever pg_restore's
# exit code said.
for table in users roles permissions audit_logs; do
  count="$(docker compose exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${TARGET_DB}" \
    -tAc "SELECT count(*) FROM ${table}")"
  echo "    ${table}: ${count} row(s)"
done

echo
echo "==> Restored into ${TARGET_DB}"
echo "    The live database is untouched. Check the data, then promote if it is what you need."
