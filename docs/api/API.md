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

## Catalogue · public

Every route here is public: a customer browsing does not have an account. The
scoping is structural rather than permission-based — these read only published,
non-deleted products, and no parameter can widen that.

| Endpoint                           | Purpose                                      |
| ---------------------------------- | -------------------------------------------- |
| `GET /catalogue/products`          | Browse and search, with facet counts         |
| `GET /catalogue/products/:slug`    | One published product, in full               |
| `GET /catalogue/categories`        | The active category tree                     |
| `GET /catalogue/ingredients/:slug` | One ingredient, with sourcing and warnings   |
| `GET /catalogue/sitemap`           | Indexable URLs, excluding anything `noindex` |

`GET /catalogue/products` accepts `q`, `category`, `type`, `brand`,
`minPriceCents`, `maxPriceCents`, repeatable `attr=key:value`, `sort` and
`cursor`. Search is full-text with a trigram fallback, so a misspelling still
finds the product; when a query returns nothing, `meta.suggestion` carries a
spelling suggestion — and only then, so it never second-guesses a query that
worked.

Results are ranked, so `cursor` encodes an offset rather than a row key: a
relevance score is not something you can resume from.

## Catalogue administration

Under `/admin/catalogue`. The permission split is deliberate: `PRODUCT_WRITE`
edits a draft, `PRODUCT_PUBLISH` moves a listing between statuses. Someone can
be trusted to write product copy without being trusted to put it in front of
customers.

| Endpoint                                                                 | Permission                   |
| ------------------------------------------------------------------------ | ---------------------------- |
| `GET/POST /products`, `PATCH /products/:id`                              | `PRODUCT_READ/WRITE`         |
| `GET /products/:id/readiness`                                            | `PRODUCT_READ`               |
| `PUT /products/:id/status`                                               | `PRODUCT_PUBLISH`            |
| `PUT /products/:id/{ingredients,categories,images,warnings,disclaimers}` | `PRODUCT_WRITE`              |
| `DELETE /products/:id`                                                   | `PRODUCT_WRITE`              |
| `.../categories`, `.../ingredients`                                      | `CATEGORY_*`, `INGREDIENT_*` |

A product is always created as a draft; there is no field on `POST /products`
that produces a publicly visible listing.

### The publishing gate

`PUT /products/:id/status` is the only way a listing becomes visible, and it
evaluates the checklist at the transition — against current data, not against
what the admin screen was showing. A refusal is `422 PRECONDITION_FAILED` with
one `details` entry per failing check, keyed by the check name.

The same gate guards the move into `READY`, minus the compliance signature, so
that status is a claim the data supports.

`GET /products/:id/readiness` returns the same evaluation without attempting a
transition:

```json
{
  "ready": false,
  "blockedBy": ["IMAGES", "COMPLIANCE_APPROVED"],
  "notYetEnforced": ["CLAIMS_REVIEWED", "EVIDENCE_REVIEWED", "INVENTORY_CONFIGURED"],
  "checks": [
    { "key": "IMAGES", "state": "FAIL", "detail": "No hero image.", "implementedInPhase": 2 },
    { "key": "CLAIMS_REVIEWED", "state": "NOT_YET_ENFORCED", "detail": "Evaluated from Phase 4." }
  ]
}
```

`NOT_YET_ENFORCED` means the domain that would evaluate the check does not
exist in this build. It is reported rather than counted as a pass, and it does
not block, because nobody could satisfy it. Which checks are _required_ is
configuration (`catalog.publish_checklist`); removing a key stops a finding
blocking publication, it does not stop the finding being reported.

Taking a live listing out of sale requires a `reason`, which is recorded.

## Compliance

| Endpoint                                 | Permission                 |
| ---------------------------------------- | -------------------------- |
| `GET /compliance/products/:id`           | `COMPLIANCE_READ`          |
| `GET /compliance/products/:id/history`   | `COMPLIANCE_READ`          |
| `POST /compliance/products/:id/decision` | `COMPLIANCE_APPROVE` + MFA |
| `GET /compliance/expiring`               | `COMPLIANCE_READ`          |

`ADMIN` deliberately does not hold `COMPLIANCE_APPROVE`. Administering the store
and signing off a health product listing are separate authorities.

A decision carries `notes` with a real minimum length — a decision without
reasoning is not a review. The record is append-only at the database level and
snapshots the checklist the reviewer saw. Approving is not publishing: it
satisfies one check, and the gate re-evaluates everything at the transition.

Approvals expire after `compliance.claims_review_interval_days`. A rejection
takes a live listing down immediately.

## Media

| Endpoint             | Permission      |
| -------------------- | --------------- |
| `POST /media/images` | `PRODUCT_WRITE` |
| `GET /media`         | `PRODUCT_READ`  |
| `GET /media/:id`     | `PRODUCT_READ`  |
| `DELETE /media/:id`  | `PRODUCT_WRITE` |

Uploads are `multipart/form-data`. The file is decoded before it is trusted —
the filename and the declared content type are both caller-supplied and neither
is evidence of anything — then re-encoded to strip EXIF (including GPS) and
stored under a key derived from its SHA-256, so the same bytes uploaded twice
are one object. SVG is rejected: it is a document format that can carry script.

Deletion is soft. The stored object stays, because keys are content-addressed
and another record may reference the same bytes.

## Content and SEO

| Endpoint                                  | Permission           |
| ----------------------------------------- | -------------------- |
| `GET /content/pages/:slug` · public       | —                    |
| `GET /content/sitemap` · public           | —                    |
| `GET/POST /content/admin/pages`           | `CONTENT_READ/WRITE` |
| `PATCH /content/admin/pages/:id`          | `CONTENT_WRITE`      |
| `POST /content/admin/pages/:id/publish`   | `CONTENT_PUBLISH`    |
| `POST /content/admin/pages/:id/unpublish` | `CONTENT_PUBLISH`    |
| `GET/PUT /content/admin/seo/:type/:id`    | `SEO_READ/WRITE`     |

Page content is an array of typed blocks, never HTML. An editor that accepted
HTML would eventually store a script tag, and rendering it would be stored XSS;
blocks cannot express script at all.

`PATCH` on a published page writes to the draft columns only. The live page does
not change until someone publishes, so saving a half-finished edit to the
shipping policy does not change the shipping policy. The public read endpoint
has no parameter that could return draft content.

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
