#!/usr/bin/env bash
#
# Restore drill.
#
# Dumps the database, encrypts it, decrypts it, restores it into a scratch
# database, and then checks that what came back is actually usable — then times
# every step so the recovery objective in docs/operations/DISASTER-RECOVERY.md
# is a measurement rather than an estimate.
#
# This exists because scripts/backup.sh and scripts/restore.sh both shell out to
# `docker compose exec postgres`, which means they cannot run anywhere the
# compose stack is not up — including CI, and including the Render topology.
# This script talks to PostgreSQL over a connection string instead, so the drill
# can run in the places where a drill is actually useful.
#
# It never touches the source database. The scratch database is dropped on exit
# unless --keep is passed.
#
# Usage:
#   ./scripts/restore-drill.sh [--keep] [--source <connection-string>]
#
# Environment:
#   DATABASE_URL            source database, if --source is not given
#   BACKUP_AGE_RECIPIENT    age public key; with BACKUP_AGE_IDENTITY this
#   BACKUP_AGE_IDENTITY     exercises the REAL backup key pair
#
# With no age key configured the drill generates a throwaway pair, which tests
# that the encryption round-trip works but tells you nothing about whether your
# production key can still decrypt your production backups. It says so loudly.

set -euo pipefail

KEEP_SCRATCH=0
SOURCE_URL="${DATABASE_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP_SCRATCH=1; shift ;;
    --source) SOURCE_URL="${2:?--source needs a connection string}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${SOURCE_URL:?set DATABASE_URL or pass --source}"

for tool in pg_dump pg_restore psql createdb dropdb age; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

STAMP="$(date -u +%Y%m%d%H%M%S)"
SCRATCH_DB="drill_${STAMP}"
WORK_DIR="$(mktemp -d)"

# The source database name, so the scratch name can be checked against it and
# so the admin connection can target a different database on the same server.
SOURCE_DB="$(psql "${SOURCE_URL}" -tAc 'SELECT current_database()')"
if [[ "${SCRATCH_DB}" == "${SOURCE_DB}" ]]; then
  echo "refusing to drill into the source database" >&2
  exit 1
fi

# createdb/dropdb need a connection to *some* database that is not the one being
# created or dropped. `postgres` always exists.
ADMIN_URL="${SOURCE_URL%/*}/postgres"

cleanup() {
  rm -rf "${WORK_DIR}"
  if [[ "${KEEP_SCRATCH}" -eq 0 ]]; then
    dropdb --if-exists --maintenance-db="${ADMIN_URL}" "${SCRATCH_DB}" 2>/dev/null || true
  else
    echo "    scratch database kept: ${SCRATCH_DB}"
  fi
}
trap cleanup EXIT

now_ms() { date +%s%3N; }
DRILL_START="$(now_ms)"
declare -a TIMINGS=()
step() { TIMINGS+=("$1|$2"); }

echo "==> Restore drill ${STAMP}"
echo "    source:  ${SOURCE_DB}"
echo "    scratch: ${SCRATCH_DB}"
echo

# --- 1. dump ---------------------------------------------------------------
echo "==> Dumping"
T0="$(now_ms)"
pg_dump --dbname="${SOURCE_URL}" \
        --format=custom --compress=9 --no-owner --no-privileges \
        --file="${WORK_DIR}/dump.pgc"
step dump "$(( $(now_ms) - T0 ))"

DUMP_BYTES="$(stat -c %s "${WORK_DIR}/dump.pgc")"
echo "    ${DUMP_BYTES} bytes"
# A dump far smaller than expected usually means pg_dump failed part-way and
# still exited zero. backup.sh makes the same check for the same reason.
if [[ "${DUMP_BYTES}" -lt 4096 ]]; then
  echo "==> Dump is implausibly small; the drill has already failed" >&2
  exit 1
fi

# --- 2. encrypt and decrypt ------------------------------------------------
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" && -n "${BACKUP_AGE_IDENTITY:-}" ]]; then
  RECIPIENT="${BACKUP_AGE_RECIPIENT}"
  IDENTITY="${BACKUP_AGE_IDENTITY}"
  KEY_NOTE="production key pair"
else
  echo "==> No BACKUP_AGE_RECIPIENT/IDENTITY set — generating a throwaway pair"
  echo "    This proves the round-trip works. It does NOT prove your production"
  echo "    key can still decrypt your production backups, which is the failure"
  echo "    that actually ruins a recovery. Set both variables to test that."
  age-keygen -o "${WORK_DIR}/drill.key" 2>/dev/null
  RECIPIENT="$(grep 'public key:' "${WORK_DIR}/drill.key" | awk '{print $NF}')"
  IDENTITY="${WORK_DIR}/drill.key"
  KEY_NOTE="THROWAWAY key pair — production key untested"
fi

echo "==> Encrypting"
T0="$(now_ms)"
age --recipient "${RECIPIENT}" --output "${WORK_DIR}/dump.pgc.age" "${WORK_DIR}/dump.pgc"
step encrypt "$(( $(now_ms) - T0 ))"

# Remove the plaintext so the decrypt step genuinely has to work rather than
# quietly restoring from a file that was never encrypted at all.
rm -f "${WORK_DIR}/dump.pgc"

head -c 64 "${WORK_DIR}/dump.pgc.age" | grep -q 'age-encryption' \
  || { echo "==> Encrypted file is not an age archive" >&2; exit 1; }

echo "==> Decrypting"
T0="$(now_ms)"
age --decrypt --identity "${IDENTITY}" \
    --output "${WORK_DIR}/restored.pgc" "${WORK_DIR}/dump.pgc.age"
step decrypt "$(( $(now_ms) - T0 ))"

# --- 3. restore ------------------------------------------------------------
echo "==> Creating ${SCRATCH_DB}"
createdb --maintenance-db="${ADMIN_URL}" "${SCRATCH_DB}"
SCRATCH_URL="${SOURCE_URL%/*}/${SCRATCH_DB}"

echo "==> Restoring"
T0="$(now_ms)"
# pg_restore reports non-fatal issues with exit 1; only a hard failure should
# fail the drill, and the verification below is what decides whether the
# restore was actually good.
pg_restore --dbname="${SCRATCH_URL}" --no-owner --no-privileges --jobs 4 \
           "${WORK_DIR}/restored.pgc" 2>"${WORK_DIR}/restore.log" || RESTORE_WARNED=1
step restore "$(( $(now_ms) - T0 ))"

if [[ -n "${RESTORE_WARNED:-}" ]]; then
  echo "    pg_restore reported warnings:"
  sed 's/^/      /' "${WORK_DIR}/restore.log" | head -20
fi

# --- 4. verify -------------------------------------------------------------
#
# A restore that produced an empty schema is a failure whatever pg_restore's
# exit code said. These checks compare the restored database against the source
# rather than against hardcoded expectations, so the drill stays honest as the
# schema grows.

echo
echo "==> Verifying"
T0="$(now_ms)"
FAILURES=0

compare() {
  local label="$1" query="$2" src dst
  src="$(psql "${SOURCE_URL}" -tAc "${query}")"
  dst="$(psql "${SCRATCH_URL}" -tAc "${query}")"
  if [[ "${src}" == "${dst}" ]]; then
    printf '    ok    %-28s %s\n' "${label}" "${dst}"
  else
    printf '    FAIL  %-28s source=%s restored=%s\n' "${label}" "${src}" "${dst}"
    FAILURES=$((FAILURES + 1))
  fi
}

compare "tables"            "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
compare "check constraints" "SELECT count(*) FROM pg_constraint WHERE contype='c'"
compare "foreign keys"      "SELECT count(*) FROM pg_constraint WHERE contype='f'"
compare "indexes"           "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"

for table in users roles permissions audit_logs customers products orders; do
  compare "rows: ${table}" "SELECT count(*) FROM ${table}"
done

# The append-only triggers are the point of several compliance guarantees. A
# restore that silently dropped them would look fine and quietly allow the audit
# trail to be rewritten, which is the worst possible way to discover a problem.
echo
echo "    Append-only protection:"
for table in audit_logs customer_consents compliance_reviews product_claim_versions \
             claim_reviews batch_events recall_actions ai_interactions; do
  enabled="$(psql "${SCRATCH_URL}" -tAc "
    SELECT count(*) FROM pg_trigger
     WHERE tgrelid = '${table}'::regclass AND NOT tgisinternal AND tgenabled = 'O'" 2>/dev/null || echo 0)"
  if [[ "${enabled}" -gt 0 ]]; then
    printf '    ok    %-28s %s enabled trigger(s)\n' "${table}" "${enabled}"
  else
    printf '    FAIL  %-28s no enabled append-only trigger\n' "${table}"
    FAILURES=$((FAILURES + 1))
  fi
done

# Proves the trigger is not merely present but actually refusing writes.
echo
if psql "${SCRATCH_URL}" -qc "UPDATE audit_logs SET action = 'drill.tamper' WHERE true" >/dev/null 2>&1; then
  echo "    FAIL  audit_logs accepted an UPDATE — append-only is not enforced"
  FAILURES=$((FAILURES + 1))
else
  echo "    ok    audit_logs refused an UPDATE, as it must"
fi

step verify "$(( $(now_ms) - T0 ))"

# --- 5. report -------------------------------------------------------------
TOTAL="$(( $(now_ms) - DRILL_START ))"

echo
echo "==> Timings"
for entry in "${TIMINGS[@]}"; do
  printf '    %-10s %6.1fs\n' "${entry%%|*}" "$(echo "${entry##*|}" | awk '{print $1/1000}')"
done
printf '    %-10s %6.1fs\n' "TOTAL" "$(echo "${TOTAL}" | awk '{print $1/1000}')"

echo
echo "    Dump size:   ${DUMP_BYTES} bytes"
echo "    Encryption:  ${KEY_NOTE}"
echo
echo "    This total is the database portion of recovery only. A real RTO also"
echo "    includes provisioning, deploying the image and repointing DNS, and it"
echo "    scales with data volume — a drill against a small database does not"
echo "    predict a restore of a large one. Record the row counts above next to"
echo "    the time so the number means something later."

if [[ "${FAILURES}" -gt 0 ]]; then
  echo
  echo "==> DRILL FAILED: ${FAILURES} check(s) did not pass" >&2
  exit 1
fi

echo
echo "==> Drill passed. Put the total above into"
echo "    docs/operations/DISASTER-RECOVERY.md, replacing the RTO estimate, and"
echo "    note the date it was measured."
