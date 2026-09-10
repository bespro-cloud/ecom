#!/usr/bin/env bash
#
# Blocks until the API reports ready, or gives up.
#
# Readiness, not liveness: the process being up is not the same as it being able
# to serve, and deploying past a database it cannot reach helps nobody.

set -euo pipefail

BASE_URL="${1:?usage: wait-for-health.sh <base-url>}"
ATTEMPTS="${2:-40}"
INTERVAL="${3:-5}"

echo "==> Waiting for ${BASE_URL}/health/ready"

for attempt in $(seq 1 "${ATTEMPTS}"); do
  status="$(curl -fsS -o /tmp/health-body -w '%{http_code}' --max-time 10 "${BASE_URL}/health/ready" || true)"

  if [[ "${status}" == "200" ]]; then
    echo "==> Ready after ${attempt} attempt(s)"
    cat /tmp/health-body
    echo
    exit 0
  fi

  echo "    attempt ${attempt}/${ATTEMPTS}: HTTP ${status:-no response}"
  sleep "${INTERVAL}"
done

echo "==> Never became ready. Last response:" >&2
cat /tmp/health-body >&2 || true
exit 1
