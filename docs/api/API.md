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
configuration (`catalog.publish_checklist_relaxed`) — a **relaxation** list, not
an inclusion list, so a check added in a later release blocks by default rather
than silently doing nothing on deployments whose configuration predates it.
Naming a check stops it blocking publication; it does not stop the finding being
reported.

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

## Cart · public

A cart belongs to a browser, not an account. It is addressed by an httpOnly,
`SameSite=Lax` token cookie the server sets; there is no cart id in any request
body, so one customer cannot name another's cart. On sign-in the guest cart is
merged into the customer's.

| Endpoint                 | Purpose                                 |
| ------------------------ | --------------------------------------- |
| `GET /cart`              | The current cart, priced and with stock |
| `POST /cart/items`       | Add a variant, by id and quantity       |
| `PATCH /cart/items/:id`  | Change a line's quantity                |
| `DELETE /cart/items/:id` | Remove a line                           |

No request here carries a price. Every line is priced from the catalogue, and
`availableQuantity` is read from live stock, so a line that can no longer be
fulfilled says so before checkout rather than at payment.

## Checkout · public

| Endpoint                      | Purpose                                             |
| ----------------------------- | --------------------------------------------------- |
| `POST /checkout`              | Start one, under a caller-supplied idempotency key  |
| `GET /checkout/:id`           | The current quote and available shipping options    |
| `PATCH /checkout/:id`         | Set addresses and the shipping method               |
| `POST /checkout/:id/prepare`  | Lock the total, hold stock, create a payment intent |
| `POST /checkout/:id/complete` | Place the order once the provider confirms payment  |

`POST /checkout` takes `idempotencyKey`, which has a unique constraint behind
it. A double submit, a retried request or a browser that fired twice produces
**one** checkout, and the second call returns the first result.

`GET /checkout/:id` returns `pricingFingerprint` — a stable identity for the
priced basket. `prepare` requires it back, and refuses with `422
PRECONDITION_FAILED` if the basket or the catalogue moved underneath. The
fingerprint is change detection, not a security token: it is neither secret nor
signed, and nothing is authorised by it. Totals are recomputed server-side
either way.

`prepare` does four things in a fixed order: reprice, verify the fingerprint,
reserve stock, then create the payment intent. Reserving before the intent
exists is deliberate — money taken for goods that are not there is the worst
outcome available, so a failure to reserve stops the payment ever being created.

`complete` asks the provider whether the payment settled, rather than believing
the caller. It is idempotent: calling it again returns the same order. Calling
it before payment settles is refused with `422`.

`taxRateApplied` is `null` when no tax rate is configured, which prices tax at
zero and says so. That is distinguishable from a configured rate of zero, and
neither is a tax calculation — see the Phase 3 notes in the roadmap.

## Orders · customer

| Endpoint          | Purpose                             |
| ----------------- | ----------------------------------- |
| `GET /orders`     | The signed-in customer's own orders |
| `GET /orders/:id` | One order, in full                  |

`GET /orders` requires a session and is scoped by the customer id on it, never
by anything in the request.

`GET /orders/:id` also accepts a guest: someone who has just checked out has no
customer record, and is matched instead against the **cart cookie that produced
the order** — an httpOnly credential they already hold. There is deliberately no
token in the URL: a URL token ends up in access logs, browser history and
`Referer` headers, which is the last place a bearer credential for someone's
order should be. A request carrying neither credential, or the wrong one, gets
`404` rather than `403` — confirming an order exists is itself information about
someone else's purchase.

No order confirmation email is sent yet; nothing in the product claims one is.

## Payment webhooks

`POST /webhooks/payments` · public by route, authenticated by **signature**.

The signature is the only thing distinguishing the provider from anyone else
who can reach this URL, so:

- The **raw request body** is verified, not a re-serialised object. Signatures
  are computed over exact bytes and re-serialising JSON changes them. Raw-body
  parsing is scoped to this route alone.
- Comparison is constant-time, within a timestamp tolerance window, and accepts
  multiple `v1` signatures so a webhook secret can be rotated without dropping
  events.
- An unverifiable payload is refused with `403` and recorded as an audit event.
  Repeated failures here mean someone is probing the endpoint.
- Events are deduplicated on the provider's own event id through a unique
  constraint — not a read-then-write, which has a window in which two parallel
  deliveries both pass the check and a capture is applied twice.
- A verified event always answers `200`, duplicates included. A provider that
  receives an error retries, so returning one for work already done produces an
  infinite retry loop.

## Commerce administration

Under `/admin/commerce`. The permission split reflects who is trusted with what:
looking at an order, stopping one, and giving money back are three different
authorities.

| Endpoint                         | Permission                 |
| -------------------------------- | -------------------------- |
| `GET /orders`, `GET /orders/:id` | `ORDER_READ`               |
| `POST /orders/:id/notes`         | `ORDER_WRITE`              |
| `POST /orders/:id/cancel`        | `ORDER_CANCEL`             |
| `POST /orders/:id/refunds`       | `REFUND_ISSUE` **and MFA** |
| `GET /orders/:id/refunds`        | `REFUND_READ`              |
| `GET /inventory`                 | `INVENTORY_READ`           |
| `POST /inventory`                | `INVENTORY_ADJUST`         |
| `POST /inventory/adjustments`    | `INVENTORY_ADJUST`         |
| `GET /inventory/:id/adjustments` | `INVENTORY_READ`           |
| `GET /warehouses`                | `INVENTORY_READ`           |
| `POST /warehouses`               | `INVENTORY_ADJUST`         |
| `GET /shipping-rates`            | `ORDER_READ`               |
| `POST /shipping-rates`           | `SYSTEM_SETTINGS`          |

### Refunds

`POST /orders/:id/refunds` requires MFA on the route, and `ORDER_MANAGER` — the
role that holds `REFUND_ISSUE` — is itself marked as requiring MFA. This moves
money out of the business.

`amountCents` is the one place a caller names money, and it is a _request_: the
server recomputes the ceiling from the order's own stored line totals and what
the provider says remains captured, and refuses anything above it with `422`.
Line-scoped refunds are computed from stored totals too, checked against what
has already been refunded per line, so the same unit cannot be refunded twice.

`idempotencyKey` is required and unique. A repeated key returns the refund it
produced without touching the provider again — **unless** that attempt failed,
in which case it is re-driven rather than replayed. Replaying a failure would
make a transient provider outage permanent under that key; re-driving is safe
because the same key goes to the provider, which collapses the duplicate if the
first attempt did land after all. A retry that changes the amount under the same
key is refused with `409`.

`notes` is required, has a real minimum length, is attributed to a named person,
and cannot be edited afterwards.

`restock` is opt-in. Returning units to sellable stock before anyone has seen
them come back is how a warehouse promises goods it does not have.

### Inventory

Three quantities, kept distinct: `onHandQuantity` is what is physically in the
warehouse, `reservedQuantity` is what open orders have already claimed, and
`availableQuantity` is the difference — the only one a customer can buy against.
Stock leaves on-hand at fulfilment, not at checkout.

Quantities never move by being set. `POST /inventory/adjustments` takes a signed
`quantityDelta` with a required `reason`, and writes it to an append-only ledger
alongside the resulting on-hand figure — so "we are eleven units short" is
answerable months later. `POST /inventory` sets policy only (`reorderPoint`,
`trackInventory`, `allowBackorder`).

An adjustment that would take on-hand below zero, or below what is reserved for
open orders, is refused with `409`. The database enforces the same floor with a
CHECK constraint regardless of what the application asks for.

Reservations are taken under `SELECT … FOR UPDATE` row locks, acquired in a
fixed order sorted by variant id. The lock prevents two checkouts reading the
same availability and both succeeding; the fixed order prevents them deadlocking
against each other.

## Claims and evidence

Under `/admin/compliance`. The permission split is the substance of the
separation of duty:

| Endpoint                                    | Permission                     |
| ------------------------------------------- | ------------------------------ |
| `GET /claims`, `GET /claims/:id`            | `CLAIM_READ`                   |
| `POST /products/:id/claims`                 | `CLAIM_WRITE`                  |
| `POST /claims/:id/versions`                 | `CLAIM_WRITE`                  |
| `POST /claims/:id/submit`                   | `CLAIM_WRITE`                  |
| `POST /claims/:id/decision`                 | `CLAIM_APPROVE` **and MFA**    |
| `POST /claims/:id/withdraw`                 | `CLAIM_WRITE`                  |
| `GET/POST /evidence`, `PATCH /evidence/:id` | `EVIDENCE_READ/WRITE`          |
| `POST /evidence/:id/decision`               | `EVIDENCE_APPROVE` **and MFA** |
| `POST /claims/:id/evidence`                 | `EVIDENCE_WRITE`               |
| `DELETE /claims/:id/evidence/:evidenceId`   | `EVIDENCE_WRITE`               |
| `GET/POST /documents`                       | `DOCUMENT_READ/WRITE`          |

`CLAIM_APPROVE` is held by compliance reviewers and by nobody else — not
`ADMIN`, not `PRODUCT_MANAGER`. The person who writes a health claim is
deliberately not the person who signs it off.

### What a claim is, and what the gate checks

A claim is a record someone wrote. **Nothing reads marketing copy and infers
one.** That inference about regulated speech is not one software should make,
and it would fail in the direction nobody notices — the claim it missed is the
one that goes out unreviewed.

So the division of labour is explicit: `CLAIMS_REVIEWED` guarantees that no
_recorded_ claim reaches a customer unapproved, and the human compliance review
is where someone attests the copy makes no claims beyond those recorded. The
check's `detail` says so in those words rather than letting a `PASS` imply more.

### Versioning

`POST /claims/:id/versions` writes a new version and takes the claim back out of
approval. **It never touches the approved version.** Until the new wording is
itself approved, the public listing keeps showing the text that was signed off —
the API reads `approvedVersion`, not `currentVersion`, so there is no state in
which an unreviewed edit appears on a live page.

`POST /claims/:id/decision` names the `versionId` it applies to and is refused
with `409` if the wording moved underneath. An approval that silently attached to
a later edit would be a signature on text the signatory never saw.

Version rows and decision rows are append-only at the database level.

### Substantiation

A structure/function, nutrient-content or health claim cannot be submitted or
approved without at least one **accepted** source linked as `DIRECT` or
`INDIRECT`. `CONTRADICTORY` is a relevance a reviewer can record on purpose — a
substantiation file containing only supportive studies is a sales document — but
it cannot be what an approval rests on.

A `DISEASE` claim is refused on category alone, however much evidence is
attached. No amount of substantiation makes one lawful on a supplement listing.

There is no score, no weighting and no threshold beyond "at least one". Weighing
whether a study supports a sentence is the reviewer's judgement and the whole
substance of their job; a confidence figure would look like the software had
formed a view.

`limitations` is required on every source, with a real minimum length in Zod and
again as a database `CHECK`. Evidence recorded without stated limitations is
evidence being oversold, and it is the field that gets left blank first.

Reviewed evidence cannot be edited (`409`): approvals rest on what it said. A
correction is a new record, which forces the claim to be re-reviewed against it.

### Documents

Every document is returned with `issuerAsStated` rather than `issuer`, and a
`verification: "NOT_VERIFIED_BY_THIS_SYSTEM"` field. The system records that a
person uploaded a file and said what it is. It does not verify an issuer, check a
certificate against a registry, or in any way evidence that a certification is
valid. A document past its stated expiry is reported as `expired: true` rather
than quietly ignored.

## Lots and recalls

Under `/admin/traceability`.

| Endpoint                                 | Permission                  |
| ---------------------------------------- | --------------------------- |
| `GET /batches`, `GET /batches/:id`       | `BATCH_READ`                |
| `POST /batches`                          | `BATCH_WRITE`               |
| `POST /batches/:id/disposition`          | `BATCH_QUARANTINE`          |
| `POST /lot-tracking`                     | `BATCH_WRITE`               |
| `GET /recalls`, `GET /recalls/:id`       | `RECALL_READ`               |
| `GET /recalls/:id/impact`                | `RECALL_READ`               |
| `POST /recalls`, `.../lots`, `.../notes` | `RECALL_MANAGE`             |
| `POST /recalls/:id/open`                 | `RECALL_MANAGE` **and MFA** |
| `POST /recalls/:id/approve-notification` | `RECALL_NOTIFY` **and MFA** |
| `POST /recalls/:id/close`                | `RECALL_MANAGE`             |
| `POST /recalls/:id/cancel`               | `RECALL_MANAGE` **and MFA** |

### First-expiry-first-out

When a stock record is lot-tracked, allocation draws from lots ordered by
`expires_at ASC NULLS LAST, received_at ASC`, under `FOR UPDATE` taken in the
same statement that orders them. Only `AVAILABLE` lots are selected, and the
filter is in the SQL rather than in a caller-supplied parameter: there is no
argument that widens it to quarantined, recalled or expired stock.

An undated lot sorts **last**, not first. "No expiry recorded" is not evidence of
freshness.

If no allocatable lot covers the order, allocation **refuses**. That is the
correct refusal: shipping a regulated product without being able to say which lot
it came from defeats the point of tracking lots. `availability` reports only
allocatable units, so 50 units on the shelf with 40 quarantined reports as 10.

### Disposition

`POST /batches/:id/disposition` requires a written reason in both directions and
writes it to an append-only ledger. Releasing is the more dangerous of the two to
have no record of: "why was this held?" usually has a paper trail elsewhere,
while "on what basis did we decide it was fine?" often does not.

Recalled and expired stock can never return to sale. Correcting a mistaken recall
means receiving the goods again as a new lot, with the receipt recorded.

Units already reserved against open orders are left alone by a disposition
change. Cancelling someone's paid order is a decision for a person with the order
in front of them, not a side effect of a warehouse action.

### Recalls, and the one rule that matters

**This system never contacts anyone.**

Opening a recall withdraws every lot in scope from sale immediately and
automatically. That asymmetry is deliberate: stock that may be unsafe should stop
being sold the moment somebody with the authority says so, and requiring a second
approval to _stop selling_ would get the risk exactly the wrong way round.

`GET /recalls/:id/impact` derives which orders received units from the recalled
lots. What it returns depends on whether contact has been approved:

- **Before approval** — counts only. Orders, distinct customers, units, broken
  down by product. Enough to assess scale and brief a regulator; `orders` is
  `null`.
- **After approval** — the same counts plus the affected orders and the contact
  details needed to reach them.

The withholding happens in the service, not in a controller or a template, so
there is no route, screen or export that reaches the identities by asking
differently. Reading the impact is itself recorded on the recall, disclosed or
not.

`POST /recalls/:id/approve-notification` is the decision with legal consequences
for people outside the business, and the route says so: its own permission
(`RECALL_NOTIFY`, separate from `RECALL_MANAGE`), a second factor, a written
basis, and an `acknowledgement` field that must be typed verbatim rather than
ticked — because a checkbox is exactly how someone arrives here by clicking
through screens.

Approving still **sends nothing**. It unlocks the list and records who unlocked
it and why. There is no transactional email in this platform; when there is,
dispatch must remain a further explicit act.

The database enforces the important half independently: a recall cannot sit in
`NOTIFICATION_APPROVED` without a named approver and a timestamp, and every
action on a recall is append-only.

Cancelling restores each lot to the status it held **before** the recall, not to
`AVAILABLE` — a lot already quarantined for an unrelated reason must not become
sellable because a different recall was withdrawn. Cancelling is unavailable once
contact has been approved; at that point the recall is a matter of record and is
closed rather than undone.

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
