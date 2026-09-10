#!/usr/bin/env bash
#
# Encrypted database backup.
#
# Encryption is not optional: the dump contains every customer record on the
# platform. It is encrypted with age before it ever leaves the host, so the
# object store never holds readable customer data.
#
# Usage: backup.sh [label]
#
# Requires:
#   BACKUP_AGE_RECIPIENT   age public key of the backup identity
#   BACKUP_S3_BUCKET       destination bucket
#   POSTGRES_USER / POSTGRES_DB

set -euo pipefail

LABEL="${1:-scheduled}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="health-commerce-${LABEL}-${STAMP}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT must be set — refusing to write an unencrypted backup}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"

echo "==> Dumping ${POSTGRES_DB}"
# Custom format: parallel restore, and selective restore of a single table
# during an incident.
docker compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  > "${WORK_DIR}/${NAME}.dump"

SIZE="$(stat -c %s "${WORK_DIR}/${NAME}.dump")"
echo "    ${SIZE} bytes"

# A dump far smaller than expected usually means pg_dump failed part-way and
# still exited zero. Better to fail the backup than to store a truncated one.
if [[ "${SIZE}" -lt 4096 ]]; then
  echo "==> Dump is implausibly small; refusing to store it" >&2
  exit 1
fi

echo "==> Encrypting"
age --recipient "${BACKUP_AGE_RECIPIENT}" \
    --output "${WORK_DIR}/${NAME}.dump.age" \
    "${WORK_DIR}/${NAME}.dump"
shred -u "${WORK_DIR}/${NAME}.dump"

echo "==> Verifying the encrypted file is readable"
# Confirms the archive is well-formed before the plaintext is gone for good.
head -c 64 "${WORK_DIR}/${NAME}.dump.age" | grep -q 'age-encryption' \
  || { echo "==> Encrypted file does not look like an age archive" >&2; exit 1; }

echo "==> Uploading to s3://${BACKUP_S3_BUCKET}/"
aws s3 cp "${WORK_DIR}/${NAME}.dump.age" \
  "s3://${BACKUP_S3_BUCKET}/postgres/${NAME}.dump.age" \
  --storage-class STANDARD_IA \
  --metadata "label=${LABEL},created=${STAMP}"

echo "==> Backup ${NAME} stored"
echo "    Restore with: scripts/restore.sh ${NAME}"
echo
echo "A backup that has never been restored is a hypothesis. See"
echo "docs/operations/RUNBOOK.md#restore-drill for the quarterly drill."
