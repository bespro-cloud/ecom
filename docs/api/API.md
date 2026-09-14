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

| Endpoint                                | Purpose                                      |
| --------------------------------------- | -------------------------------------------- |
| `GET /catalogue/products`               | Browse and search, with facet counts         |
| `GET /catalogue/products/:slug`         | One published product, in full               |
| `GET /catalogue/products/:slug/reviews` | Published reviews and the rating summary     |
| `GET /catalogue/categories`             | The active category tree                     |
| `GET /catalogue/ingredients/:slug`      | One ingredient, with sourcing and warnings   |
| `GET /catalogue/sitemap`                | Indexable URLs, excluding anything `noindex` |

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
it and why. Transactional email exists in this platform from Phase 5, and recall
notification is deliberately not wired to it: dispatch must remain a further
explicit act rather than a consequence of approval.

The database enforces the important half independently: a recall cannot sit in
`NOTIFICATION_APPROVED` without a named approver and a timestamp, and every
action on a recall is append-only.

Cancelling restores each lot to the status it held **before** the recall, not to
`AVAILABLE` — a lot already quarantined for an unrelated reason must not become
sellable because a different recall was withdrawn. Cancelling is unavailable once
contact has been approved; at that point the recall is a matter of record and is
closed rather than undone.

## Reviews

| Endpoint                                         | Permission        |
| ------------------------------------------------ | ----------------- |
| `GET /catalogue/products/:slug/reviews` · public | —                 |
| `POST /account/reviews`                          | session           |
| `GET /account/reviews`                           | session           |
| `GET /admin/lifecycle/reviews`                   | `REVIEW_READ`     |
| `GET /admin/lifecycle/reviews/:id`               | `REVIEW_READ`     |
| `POST /admin/lifecycle/reviews/:id/moderate`     | `REVIEW_MODERATE` |

**A review is never visible on the strength of being written.** `POST` returns
`status: "PENDING"` and a `visibility` sentence saying a person will read it
first. There is no rating threshold that auto-approves and no state-machine edge
that bypasses a moderator.

**`verifiedPurchase` is derived, never asserted.** The create schema has no such
field. The badge comes from an order line belonging to the caller, resolved from
the optional `orderItemId`; naming somebody else's line produces a refusal, not
an un-badged review.

**`claimPromptTerms` and `adverseEventPromptTerms` are advisory.** They record
which phrases matched a word list, so a moderation screen can put a banner at
the top. Nothing in the system branches on them to decide an outcome: a word
list cannot tell whether "it cured my headache" is a disease claim in context.

Moderation requires written `notes` on **every** outcome, publication included,
and `reason` additionally when rejecting. `flagAdverseEvent` is recorded
independently of the decision — a customer describing harm is a safety signal
whether or not their words go on the site. Escalation to compliance cannot be
taken back.

The public route returns `summary.average` as `null` when nothing is published:
"no reviews yet" and "averages zero stars" are different facts, and zero is not
a rating anyone can give. The average is computed over the published set in the
same query, so unmoderated text cannot move the number while its words stay
hidden.

## Discount codes

| Endpoint                                   | Permission     |
| ------------------------------------------ | -------------- |
| `POST /checkout/:id/coupon` · public       | —              |
| `DELETE /checkout/:id/coupon` · public     | —              |
| `GET /admin/lifecycle/coupons`             | `COUPON_READ`  |
| `POST /admin/lifecycle/coupons`            | `COUPON_WRITE` |
| `POST /admin/lifecycle/coupons/:id/active` | `COUPON_WRITE` |

**The code is the entire input.** `applyCouponSchema` has one field. What the
code is worth is looked up and recomputed on every repricing, so there is no
amount a request could name and no stored figure to go stale against a basket
that changed underneath it.

A checkout view carries `coupon.applied` and, when it is false, a `message`
saying why — a code that stopped applying is explained rather than silently
dropped.

Percentages are expressed in basis points (1250 = 12.5%) and **round down**.
Redemption limits are enforced by counting redemption rows under
`SELECT … FOR UPDATE`, not by a counter, so two concurrent checkouts cannot both
take the last remaining use. A `maxPerCustomer` limit is refused unless
`requiresCustomer` is set: there is nobody to count a guest's redemptions
against, and a limit that silently does nothing is worse than no limit.

## Subscriptions

| Endpoint                                 | Permission          |
| ---------------------------------------- | ------------------- |
| `GET /account/payment-methods`           | session             |
| `POST /account/payment-methods`          | session             |
| `DELETE /account/payment-methods/:id`    | session             |
| `GET /account/subscriptions`             | session             |
| `POST /account/subscriptions`            | session             |
| `PATCH /account/subscriptions/:id`       | session             |
| `POST /account/subscriptions/:id/pause`  | session             |
| `POST /account/subscriptions/:id/resume` | session             |
| `POST /account/subscriptions/:id/cancel` | session             |
| `GET /admin/lifecycle/subscriptions`     | `SUBSCRIPTION_READ` |
| `GET /admin/lifecycle/subscriptions/:id` | `SUBSCRIPTION_READ` |

**There is no field anywhere for a card number.** `attachPaymentMethodSchema`
takes the provider token the browser received after sending the card to the
provider directly. No `number`, no `expiry`, no `cvc`, and no shape in which one
could be passed — that is what keeps this application out of PCI DSS scope. The
brand and last four are read back **from the provider**, not accepted from the
request: a client that could label its own token could label somebody else's
saved card however it liked.

**Renewals charge the agreed price.** Item prices live on the subscription and
are not re-read from the catalogue. A catalogue price change does not reach an
existing subscription at all; changing what a subscriber pays needs their
agreement, and that flow does not exist yet.

**Billing is idempotent per period.** A `SubscriptionInvoice` row is unique on
`(subscription, period start)` and is written **before** the provider is called.
A second run for the same period loses the insert and returns without charging;
a crash between charging and recording leaves an invoice to reconcile against
rather than money that left with no trace. A separate guard refuses a
subscription whose `nextBillingAt` has not arrived, because a success rolls the
period forward and the constraint would not fire on an early second call.

**A failed renewal stops fulfilment immediately.** The subscription moves to
`PAST_DUE`: billable, not shippable. Retries follow a bounded schedule
(`subscriptions.dunning_days`, default 1/3/5 days); when it is exhausted the
subscription is left `UNPAID` rather than retried forever.

Cancelling takes effect immediately, needs no reason, and has no retention step.
A cancelled subscription cannot hold a `next_billing_at` at all — a database
CHECK refuses it — so a billing run cannot charge somebody who cancelled even if
its query were wrong.

There is deliberately **no admin endpoint that charges a card**. The only code
that takes a recurring payment is `billSubscriptionPeriod` in
`@health/database`, called by the API when a subscription starts and by the
worker's hourly run. A staff member charging by hand is the path that produces
duplicate charges nobody can reconcile.

## Support conversations

| Endpoint                                    | Permission      |
| ------------------------------------------- | --------------- |
| `GET /account/support/guidance`             | session         |
| `GET /account/support`                      | session         |
| `GET /account/support/:id`                  | session         |
| `POST /account/support`                     | session         |
| `POST /account/support/:id/replies`         | session         |
| `GET /admin/lifecycle/support`              | `SUPPORT_READ`  |
| `GET /admin/lifecycle/support/:id`          | `SUPPORT_READ`  |
| `POST /admin/lifecycle/support/:id/replies` | `SUPPORT_WRITE` |
| `POST /admin/lifecycle/support/:id/status`  | `SUPPORT_WRITE` |

**There is no medical topic.** The topic enum has no option for a clinical
question, and `/guidance` returns the redirect the storefront shows **before**
the customer types. A notice that appeared afterwards would have collected the
health information it was meant to prevent.

**Internal notes are excluded in the query, not filtered afterwards.** The
customer-facing read passes `where: { isInternal: false }`; a `.filter()` on a
result set is one careless refactor away from leaking staff commentary to the
person it is about. A customer cannot set `isInternal` — the API refuses it and
a database CHECK refuses it regardless. An internal note does not notify the
customer either: a notification about a note about them would be the same leak
by another route.

Staff replies are attributed to "Support" in the customer's view. A support
reply is from the business, not from an individual's inbox.

## Account data and erasure

| Endpoint                                              | Permission             |
| ----------------------------------------------------- | ---------------------- |
| `GET /account/consents`                               | session                |
| `PATCH /account/marketing-preferences`                | session                |
| `GET /account/export`                                 | session                |
| `GET /account/erasure`                                | session                |
| `POST /account/erasure`                               | session                |
| `GET /admin/lifecycle/erasure-requests`               | `CUSTOMER_READ`        |
| `POST /admin/lifecycle/erasure-requests/:id/decision` | `CUSTOMER_ERASE` + MFA |

`GET /account/erasure` returns what deletion **would** and **would not** remove,
shown before the customer asks rather than after. `POST` requires the literal
acknowledgement `DELETE MY ACCOUNT`, typed rather than ticked, because this is
irreversible and a checkbox is a mis-click.

Nothing is deleted by asking. A named person with `CUSTOMER_ERASE` and a second
factor decides, and written reasoning is required: this is the response to a
legal request, and "what did you remove and what did you keep?" has to be
answerable years later.

`CUSTOMER_ERASE` is deliberately separate from `CUSTOMER_WRITE`. Correcting a
misspelled name and erasing somebody's data are not the same authority, and only
one of them cannot be undone.

**What erasure retains, and why.** Orders, payments and refunds (tax,
accounting and consumer-protection records); consent history (the evidence of
what was agreed); audit records; and the reservations recording **which lots the
customer received** — that last one is what lets a recall reach them, and the
obligation does not lapse because somebody closed their account. Reviews are
**anonymised rather than deleted**: removing them would silently change a
published rating other customers are relying on. The name comes off; the words
stay.

Marketing preferences write to an append-only consent ledger, so withdrawal adds
an entry rather than erasing the grant. Transactional mail is not on that list:
you cannot unsubscribe from being told your order shipped.

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

## Analytics

| Endpoint                               | Permission       |
| -------------------------------------- | ---------------- |
| `POST /analytics/collect` · public     | —                |
| `GET /admin/growth/analytics/overview` | `ANALYTICS_READ` |
| `GET /admin/growth/analytics/channels` | `ANALYTICS_READ` |
| `GET /admin/growth/analytics/products` | `ANALYTICS_READ` |

**Nothing identifying is stored, and there is nowhere to store it.** No
analytics table has a customer id, user id, email, order id or IP address. That
is enforced by a database event trigger, not by convention: a migration adding
`customer_id` to an analytics table fails.

The reason is specific to this business. A record that a named person viewed a
menopause supplement or a sleep aid is a health inference about them, and
enforcement actions against health companies have turned on exactly that data
reaching analytics vendors.

**The collector refuses more than it accepts.**

- The query string is discarded in full before a path is stored — not filtered,
  discarded. A deny-list of parameter names loses the next time somebody adds
  one, and here the thing that leaks could be a health detail.
- `order_placed` cannot be reported by a browser. Conversions are written
  server-side from real orders.
- The event type is an allow-list, in the schema and in a database CHECK.
- The body is `.strict()`: an unexpected field is a refusal, not a silently
  ignored value somebody later assumes is stored.
- Timestamps are clamped to arrival, so a client cannot backdate an event into a
  closed rollup.
- A referrer is reduced to a **host**; a CHECK refuses a stored value containing
  `/`.
- Location is a two-letter country and nothing finer.

**Privacy signals beat consent.** `Sec-GPC: 1` and `DNT: 1` refuse collection
even when the body says the visitor agreed — a browser-level opt-out is the more
considered instruction, and GPC is legally binding under the CPRA. Consent
itself is opt-in: silence is a no.

The endpoint always answers `202` with an empty body, whether or not anything
was recorded. Reporting the refusal would make it an oracle for probing which
visitors are measured.

**Visitor identity rotates daily.** A visitor hash is `sha256(daily salt, IP,
user agent)`; the salt is generated per UTC day and deleted with the events it
protected. The same person on two days is two visitors. Cross-day unique
visitors therefore cannot be computed, and the reports say "visitors per day,
summed" rather than implying otherwise.

**Reporting reads rollups, never raw events.** Sessions and views come from the
analytics rollups; orders and revenue come from the orders table; the two are
joined on a day and a channel label. There is no endpoint that takes a customer
id, because there is no query about an individual this system can answer.

Raw events and sessions are deleted after 30 days, along with their salts. The
rollups have no expiry: a count is not about anybody.

## Conversion attribution

An order carries `attributionChannel`, `attributionSource`, `attributionMedium`
and `attributionCampaign` — denormalised labels copied from the checkout.

**There is deliberately no session id on an order or a checkout.** An order
names a customer; that single foreign key would join a named person to every
page their visit viewed, which is what the analytics design exists to prevent.
Campaign ROI is orders-by-channel divided by sessions-by-channel: an aggregate
over an aggregate, which needs the labels and not the link.

`POST /checkout/:id/complete` accepts an optional `analyticsSessionId`. It is
used once, to write one anonymous funnel event, and then forgotten. It is not
stored on the checkout — a checkout carries an email and becomes an order.

## Blog

| Endpoint                                      | Permission                 |
| --------------------------------------------- | -------------------------- |
| `GET /blog/posts` · public                    | —                          |
| `GET /blog/posts/:slug` · public              | —                          |
| `GET /blog/categories` · public               | —                          |
| `GET /admin/growth/blog/posts`                | `BLOG_READ`                |
| `GET /admin/growth/blog/posts/:id`            | `BLOG_READ`                |
| `POST /admin/growth/blog/posts`               | `BLOG_WRITE`               |
| `PATCH /admin/growth/blog/posts/:id`          | `BLOG_WRITE`               |
| `POST /admin/growth/blog/posts/:id/submit`    | `BLOG_WRITE`               |
| `POST /admin/growth/blog/posts/:id/review`    | `COMPLIANCE_APPROVE` + MFA |
| `POST /admin/growth/blog/posts/:id/publish`   | `BLOG_PUBLISH`             |
| `POST /admin/growth/blog/posts/:id/unpublish` | `BLOG_PUBLISH`             |

**A post that names a product cannot be published by its author.** Editorial
content on a site selling regulated products is marketing copy: an article
headlined "how magnesium helps you sleep" that links to a magnesium product is
making a claim about it. Those posts need `COMPLIANCE_APPROVE` — the same
permission that signs off a product compliance review, held by compliance
reviewers and deliberately not by content staff, marketing or `ADMIN`.

A post that names **no** product publishes on the editor's own authority. The
gate is on claims about products, not a bureaucracy for every page.

**The product list is declared, not detected.** A regex over prose deciding
whether an article is "about" a product would fail in the direction nobody
notices — the post it missed is the one that publishes unreviewed claims.

**An approval is of a specific text.** The decision stores a hash of the title,
body and product list that was read, computed by the database. Publishing
recomputes it from what is actually going live, in a CHECK. Approve a recipe and
publish a disease claim and the write fails — including a direct `UPDATE`.
Editing a live post writes to the draft, so readers keep seeing the approved
text while the unapproved edit waits for review.

Written reasoning is required on either outcome, and decisions are append-only:
a trigger refuses `UPDATE` and `DELETE`.

Linked products are resolved to **published** listings only, so a post stops
linking to a product that was withdrawn after approval.

## Redirects and SEO

| Endpoint                             | Permission  |
| ------------------------------------ | ----------- |
| `POST /redirects/resolve` · public   | —           |
| `GET /admin/growth/redirects`        | `SEO_READ`  |
| `POST /admin/growth/redirects`       | `SEO_WRITE` |
| `PATCH /admin/growth/redirects/:id`  | `SEO_WRITE` |
| `DELETE /admin/growth/redirects/:id` | `SEO_WRITE` |
| `GET /admin/growth/seo/audit`        | `SEO_READ`  |

Renaming a published product, page or post writes a 301 **in the same
transaction as the rename**. A rename that committed without its redirect is a
silent 404 on a page that has been ranking for two years, and nobody notices
until the traffic has gone.

Loops are refused at any chain length — a loop is not a degraded experience, it
is the page becoming unreachable — and a self-loop is refused by a CHECK.
Renaming twice collapses `A → B → C` into `A → C` rather than extending a chain.
An `http://` destination is refused: redirecting from a secure page to an
insecure one is a downgrade, and a 301 makes it sticky in the browser.

`GET /admin/growth/seo/audit` **reports only**. Nothing in this system generates
a title, a meta description or alternative text. A meta description for a
supplement is a public statement about a health product, and a generated one is
exactly the plausible sentence that ends up claiming something nobody reviewed.
The audit names the gap; a person writes the words.

`GET /catalogue/sitemap` covers products, categories, pages and posts, and
excludes anything marked `noindex` at the source — a sitemap must not contradict
a page's own robots directive.

## AI assistance

Every route is staff-only and requires `AI_USE` on top of the permission for the
thing being drafted.

| Endpoint                                  | Permission                  |
| ----------------------------------------- | --------------------------- |
| `GET /admin/ai/status`                    | `AI_USE`                    |
| `POST /admin/ai/ask`                      | `AI_USE`                    |
| `POST /admin/ai/evidence-digest`          | `AI_USE` + `EVIDENCE_READ`  |
| `POST /admin/ai/product-copy`             | `AI_USE` + `PRODUCT_WRITE`  |
| `POST /admin/ai/seo-metadata`             | `AI_USE` + `SEO_WRITE`      |
| `POST /admin/ai/blog-outline`             | `AI_USE` + `BLOG_WRITE`     |
| `POST /admin/ai/support-reply`            | `AI_USE` + `SUPPORT_WRITE`  |
| `POST /admin/ai/analytics-summary`        | `AI_USE` + `ANALYTICS_READ` |
| `GET /admin/ai/suggestions`               | `AI_USE`                    |
| `GET /admin/ai/suggestions/:id`           | `AI_USE`                    |
| `POST /admin/ai/suggestions/:id/decision` | `AI_USE`                    |
| `GET /admin/ai/interactions`              | `AI_CONFIGURE`              |
| `GET /admin/ai/usage`                     | `AI_CONFIGURE`              |

**There is no customer-facing AI endpoint, and there is no plan for one.** An
assistant asked "will this help my anxiety?" would retrieve approved claims and
assemble them into an answer addressed to a stated condition — a health claim
made to one person about their symptom, which is what every gate in this
platform exists to prevent. It would also be a channel collecting health
information there is no lawful basis to hold. The support route drafts text for
an agent to read and edit; it sends nothing.

**Every route returns a suggestion. None of them changes anything.** A
suggestion has one of five kinds, and no kind can publish, approve, refund,
moderate or grant a permission. That is a CHECK constraint on the table, not a
convention — `PROHIBITED_OF_AI` in `@health/types` lists what is out of scope and
a unit test asserts no purpose and no suggestion kind corresponds to any entry.

`POST /admin/ai/suggestions/:id/decision` is where machine text becomes a
person's: `accept` records who accepted and applies the content to a **draft**.
Publishing that draft is a separate act, through the same gate any typed text
goes through — a blog post naming a product still needs `COMPLIANCE_APPROVE`, a
product still needs the publishing checklist. A suggestion the guardrails
blocked cannot be accepted: the API refuses it and a trigger refuses it if the
API is bypassed.

### What happens on a request

1. **Enabled?** `AI_PROVIDER=disabled` is a supported configuration. Routes
   return a plain refusal rather than an error.
2. **Redact.** Emails, phone numbers, addresses, and customer and order
   references are replaced with placeholders **before** the request is built.
   The redacted prompt is the only one that is ever stored.
3. **Ground.** Retrieval runs over approved records only — approved claim
   versions, accepted evidence, published pages and posts, descriptive product
   facts — filtered again by the permissions the asking staff member holds, so
   an answer cannot become an authorisation bypass. **If retrieval returns
   nothing, no model is called.** The response is a fixed sentence and the
   interaction is logged with outcome `NO_GROUNDING` and zero cost.
4. **Budget.** A daily spend limit in micros and an hourly per-person rate
   limit, both computed from the append-only log rather than a counter that a
   restart could reset.
5. **Call,** with a timeout and bounded retries on transient failures only.
6. **Scan.** The output is checked for disease claims, FDA and regulatory
   claims, clinical advice, approval language, citations that name nothing
   retrieved, and assertions with no support in the retrieved text. A blocking
   finding means the text is never returned to the caller — it is recorded so
   the near-miss is reviewable, and the suggestion is created `BLOCKED`.
7. **Record.** One append-only row either way, including for the calls that were
   never made.

The provider interface has no tools or function-calling surface. There is no
path by which model output becomes a call into this application.

### Retrieval is lexical, not semantic

Search matches terms against approved records in SQL. A question phrased
unlike the source text will retrieve less than a vector search would. This is
a real limitation and is stated rather than hidden: it was chosen so the
approved-only filter stays a predicate anybody can read in the query, and so no
copy of approved text is shipped elsewhere to be indexed.

### Cost and configuration

`AI_PROVIDER` is `disabled`, `development` or `anthropic`. The `development`
stand-in is refused in production by the environment contract, the same way the
mock payment provider is, and its output is labelled on every screen that shows
it. `anthropic` requires `AI_API_KEY`, and any enabled provider requires a
non-zero `AI_DAILY_BUDGET_MICROS` — an AI feature with no spending limit is an
outage waiting for a loop.

Cost is stored in micros (hundredths of a cent) as integers, priced from
`AI_INPUT_PRICE_MICROS` and `AI_OUTPUT_PRICE_MICROS`. `GET /admin/ai/usage`
reports today's spend, remaining budget, and counts by outcome and purpose.

`GET /admin/ai/interactions` is append-only and includes the redacted prompts,
the retrieved identifiers, guardrail findings and blocked text. A subsystem
whose audit trail holds only its successes is worse than none, because it looks
complete.

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
