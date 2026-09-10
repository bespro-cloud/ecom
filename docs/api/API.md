# API

Base URL: `/api/v1`. Interactive documentation is generated from the code and
served at `/api/docs` — in development only.

## Conventions

**Authentication.** Cookies for browsers (set by the auth endpoints), or
`Authorization: Bearer <access-token>` for machine clients. Every route requires
authentication unless it is explicitly marked public, so a newly added endpoint
is protected by default rather than by remembering to protect it.

**CSRF.** Cookie-authenticated, state-changing requests must echo the `hc_csrf`
cookie in an `X-CSRF-Token` header. Bearer-authenticated requests are exempt.

**Correlation.** Every response carries `X-Correlation-Id`. Send your own (a
UUID) to trace a request across the whole stack.

**Errors.** One shape, always:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request contains invalid values.",
    "correlationId": "8f2b…",
    "details": [{ "path": "password", "message": "Use at least 12 characters." }]
  }
}
```

Branch on `code`, not on `message`. Messages are written for people and will
change.

**Pagination.** Cursor-based:

```json
{ "data": [...], "meta": { "nextCursor": "…", "count": 25, "limit": 25 } }
```

Offsets are avoided: they drift when rows are inserted mid-pagination and scan
badly at depth. Cursors are opaque — do not construct one.

**Rate limits.** Responses carry `X-RateLimit-Limit` and
`X-RateLimit-Remaining`; a 429 carries `Retry-After`. Tiers: `default` for
ordinary traffic, `auth` for sign-in and MFA, `sensitive` for anything that
sends mail or changes a credential.

## Authentication

### `POST /auth/register` · public

Creates a customer account. The user, customer record, consent ledger entries,
verification token and session are written in **one transaction** — a partial
registration is not a state this system can reach.

```json
{
  "email": "ada@example.com",
  "password": "salted caramel harbour",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "acceptsTerms": true,
  "acceptsMarketingEmail": false
}
```

A duplicate address returns `409 ALREADY_EXISTS` with a message that does _not_
confirm the address is registered — otherwise registration becomes an
account-enumeration oracle.

### `POST /auth/login` · public

Either a session, or a challenge:

```json
{
  "status": "MFA_REQUIRED",
  "challengeToken": "…",
  "expiresAt": "…",
  "methods": ["TOTP", "RECOVERY_CODE"]
}
```

A wrong password and an unknown account return an identical `401
INVALID_CREDENTIALS`, and take comparable time.

### `POST /auth/mfa/verify` · public

Completes the second factor with either `code` (TOTP) or `recoveryCode` —
exactly one. The challenge token is single-use, and so is each recovery code.

### `POST /auth/refresh` · public

Rotates the refresh token. Presenting an already-used token revokes the entire
session family and returns `401 SESSION_REVOKED`.

### `POST /auth/logout` · `POST /auth/logout-all`

Ends this session, or every session for the account.

### `GET /auth/me`

The signed-in user with effective roles and permissions.

### `GET /auth/sessions`

Active sessions with coarse device and network attribution.

### Credentials

| Endpoint                     | Notes                                                      |
| ---------------------------- | ---------------------------------------------------------- |
| `POST /auth/password/forgot` | Always `202`, whether or not the address exists            |
| `POST /auth/password/reset`  | Single-use token; revokes every session                    |
| `POST /auth/password/change` | Needs the current password; keeps only the current session |
| `POST /auth/email/verify`    | Single-use token                                           |
| `POST /auth/email/resend`    | Rate limited                                               |

### MFA management

| Endpoint                        | Notes                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `GET /auth/mfa`                 | Status and remaining recovery codes                                             |
| `POST /auth/mfa/enroll`         | Returns a provisioning URI and secret — **shown once**                          |
| `POST /auth/mfa/enroll/confirm` | Activates the factor; returns recovery codes **once**                           |
| `POST /auth/mfa/recovery-codes` | Replaces the set; old codes stop working immediately                            |
| `POST /auth/mfa/disable`        | Needs password **and** a current code; refused for roles where MFA is mandatory |

## Customer account

All routes resolve the customer from the session. There is deliberately no
`/customers/:id` here — an id from the request path is never trusted to identify
the caller.

| Endpoint                        | Permission       |
| ------------------------------- | ---------------- |
| `GET /me/profile`               | customer session |
| `PATCH /me/profile`             | customer session |
| `PUT /me/preferences/marketing` | customer session |
| `GET /me/consents`              | customer session |
| `GET /me/addresses`             | customer session |
| `POST /me/addresses`            | customer session |
| `PATCH /me/addresses/:id`       | customer session |
| `DELETE /me/addresses/:id`      | customer session |

Another customer's address id returns `404`, not `403` — confirming it exists
would leak more than refusing to.

## Staff administration

| Endpoint                          | Permission    | MFA |
| --------------------------------- | ------------- | --- |
| `GET /users`                      | `USER_READ`   |     |
| `GET /users/:id`                  | `USER_READ`   |     |
| `POST /users/invite`              | `USER_WRITE`  | ✓   |
| `POST /users/invite/accept`       | public        |     |
| `PATCH /users/:id`                | `USER_WRITE`  |     |
| `PUT /users/:id/roles`            | `USER_MANAGE` | ✓   |
| `POST /users/:id/revoke-sessions` | `USER_MANAGE` | ✓   |

Staff are invited, never created with a password chosen by someone else.
Changing roles requires a written `reason`, cannot target your own account, and
revokes the target's sessions immediately.

## Roles

| Endpoint                 | Permission    | MFA |
| ------------------------ | ------------- | --- |
| `GET /roles`             | `ROLE_READ`   |     |
| `GET /roles/permissions` | `ROLE_READ`   |     |
| `POST /roles`            | `ROLE_MANAGE` | ✓   |
| `PUT /roles/:id`         | `ROLE_MANAGE` | ✓   |
| `DELETE /roles/:id`      | `ROLE_MANAGE` | ✓   |

System roles are defined in code and cannot be edited or deleted through the
API, whatever permissions the caller holds.

## System settings

| Endpoint                         | Permission        | MFA |
| -------------------------------- | ----------------- | --- |
| `GET /system/settings`           | `SYSTEM_SETTINGS` |     |
| `PUT /system/settings/:key`      | `SYSTEM_SETTINGS` | ✓   |
| `GET /system/feature-flags`      | `SYSTEM_SETTINGS` |     |
| `PUT /system/feature-flags/:key` | `SYSTEM_SETTINGS` | ✓   |

A setting's declared type is fixed; changing it is refused. Every change needs a
`reason` and is audited with the before and after value.

## Audit

`GET /audit-logs` · `AUDIT_READ`

Filter by `actorId`, `action`, `entityType`, `entityId`, `outcome`, `from`,
`to`. Newest first, cursor paginated.

There is no write endpoint, and the database rejects UPDATE and DELETE on this
table regardless.

## Health

| Endpoint          | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `/health/live`    | Process is running. Touches no dependency.          |
| `/health/ready`   | Can serve traffic. `503` when a dependency is down. |
| `/health`         | Human-readable summary.                             |
| `/health/metrics` | Prometheus exposition. Internal networks only.      |

These sit outside `/api` and are version-neutral, so probes never have to track
an API version.

## Error codes

| Code                       | Status | Meaning                                   |
| -------------------------- | -----: | ----------------------------------------- |
| `VALIDATION_FAILED`        |    400 | See `details` for field-level messages    |
| `AUTH_REQUIRED`            |    401 | No valid credentials                      |
| `INVALID_CREDENTIALS`      |    401 | Wrong password, or no such account        |
| `SESSION_EXPIRED`          |    401 | Refresh and retry                         |
| `SESSION_REVOKED`          |    401 | Sign in again; do not retry               |
| `MFA_REQUIRED`             |    403 | Complete the second factor                |
| `MFA_INVALID`              |    401 | Code wrong, spent or expired              |
| `MFA_ENROLLMENT_REQUIRED`  |    403 | Privileged role past its enrolment window |
| `CSRF_TOKEN_INVALID`       |    403 | Missing or mismatched CSRF header         |
| `INSUFFICIENT_PERMISSIONS` |    403 | Authenticated, not authorised             |
| `ACCOUNT_LOCKED`           |    403 | Temporary lockout after failed attempts   |
| `ACCOUNT_SUSPENDED`        |    403 | Account is not able to sign in            |
| `NOT_FOUND`                |    404 | No such resource, or not yours            |
| `CONFLICT`                 |    409 | State conflict                            |
| `ALREADY_EXISTS`           |    409 | Duplicate                                 |
| `PRECONDITION_FAILED`      |    422 | Preconditions not met                     |
| `RATE_LIMITED`             |    429 | Back off; see `Retry-After`               |
| `INTERNAL_ERROR`           |    500 | Quote the `correlationId` to support      |
| `DEPENDENCY_UNAVAILABLE`   |    503 | Transient; retry with backoff             |

## Versioning

The path carries the version. A breaking change means `/api/v2` with an overlap
period, not a silent change to `v1`. Adding an optional field or a new endpoint
is not breaking.
