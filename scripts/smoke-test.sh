#!/usr/bin/env bash
#
# Post-deploy smoke tests.
#
# Deliberately read-only and unauthenticated: this runs against production, so
# it must not create data or need a credential. It checks that the deployment is
# alive, wired to its dependencies, and has not lost its security headers.

set -euo pipefail

BASE_URL="${1:?usage: smoke-test.sh <base-url>}"

# The interactive API documentation is served in development but must never be
# published in production. Set SMOKE_EXPECT_DOCS=published when pointing this
# script at a development instance, so the check reads as intentional rather
# than as a surprise failure.
EXPECT_DOCS="${SMOKE_EXPECT_DOCS:-hidden}"

failures=0

check() {
  local description="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "ok    ${description}"
  else
    echo "FAIL  ${description}" >&2
    failures=$((failures + 1))
  fi
}

expect_status() {
  local expected="$1" path="$2"
  local actual
  actual="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}${path}")"
  [[ "${actual}" == "${expected}" ]]
}

expect_header() {
  local header="$1" path="${2:-/health/live}"
  curl -sS -D - -o /dev/null --max-time 10 "${BASE_URL}${path}" | grep -qi "^${header}:"
}

expect_json_field() {
  local path="$1" field="$2" value="$3"
  curl -sS --max-time 10 "${BASE_URL}${path}" | grep -q "\"${field}\":\"${value}\""
}

echo "==> Smoke testing ${BASE_URL}"

check "liveness responds"                  expect_status 200 /health/live
check "readiness responds"                 expect_status 200 /health/ready
check "database reported up"               expect_json_field /health status ok
check "unauthenticated requests refused"   expect_status 401 /api/v1/auth/me
check "unknown routes return 404"          expect_status 404 /api/v1/definitely-not-a-route
check "nosniff header present"             expect_header x-content-type-options
check "correlation id returned"            expect_header x-correlation-id /api/v1/auth/me
if [[ "${EXPECT_DOCS}" == "hidden" ]]; then
  check "interactive docs not published"   expect_status 404 /api/docs
else
  check "interactive docs served (dev)"    expect_status 200 /api/docs
fi

if [[ ${failures} -gt 0 ]]; then
  echo "==> ${failures} smoke test(s) failed" >&2
  exit 1
fi

echo "==> All smoke tests passed"
