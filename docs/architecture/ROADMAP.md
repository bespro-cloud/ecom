# Roadmap

Status is honest. "Complete" means implemented, tested against real
infrastructure, and verified end to end — not "the code compiles".

---

## Phase 1 — Foundation ✅ Complete

Monorepo, identity, RBAC, MFA, auditing, configuration and the operational
scaffolding everything else sits on.

**Delivered**

- pnpm + Turborepo monorepo; four apps, seven shared packages
- PostgreSQL 16 with Prisma; migrations and a development seed system
- Redis for rate limiting, single-use MFA nonces and BullMQ
- NestJS API at `/api/v1` with generated OpenAPI documentation
- Argon2id password hashing with opportunistic rehash on sign-in
- Refresh-token rotation with reuse detection (a replay burns the whole family)
- TOTP MFA: secrets encrypted with AES-256-GCM, counter-based replay protection,
  single-use recovery codes
- MFA mandatory for `SUPER_ADMIN`, `ADMIN` and `COMPLIANCE_REVIEWER`, with a
  bounded enrolment grace period enforced at sign-in
- 64 permissions across 11 system roles, synced from code on deploy
- Append-only audit log, enforced by database trigger
- Transactional outbox → BullMQ, with retries, jitter and dead-letter queues
- Redis-backed rate limiting (works across instances, unlike in-memory)
- Storefront: register, sign in with MFA, account, addresses, security, password
  reset, email verification
- Admin: sign in with MFA, staff administration, role browser, audit log viewer,
  settings and feature flags
- Docker images, nginx configuration, Prometheus rules, Grafana dashboard
- CI: lint, typecheck, unit, integration, build, security scan
- Encrypted backup and restore scripts

**Verified**

| Suite                     | Count | Against                  |
| ------------------------- | ----: | ------------------------ |
| Shared package unit tests |   145 | pure logic               |
| Database integration      |    17 | real PostgreSQL          |
| API integration (e2e)     |    82 | real PostgreSQL + Redis  |
| Worker integration        |     9 | real PostgreSQL + BullMQ |

**Not done in Phase 1**

- Load testing. No performance claim is made anywhere.
- Automated browser E2E (Playwright). The flows were verified manually against
  running services; the harness lands in Phase 2.
- S3 integration. MinIO runs in compose; nothing uploads to it until Phase 2.

---

## Phase 2 — Catalogue and content ✅ Complete

The catalogue, the content system, and the gate that decides what customers are
allowed to see.

**Delivered**

- Products, variants, images, attributes; categories with a materialised path
- Ingredients as shared records, with sources, warnings and allergen flags — so
  "which products contain this?" is answerable
- PostgreSQL full-text search behind a swappable provider interface: a stored
  generated `tsvector` with weighted fields, a GIN index, and trigram word
  similarity for typo tolerance
- Storefront listing with facets, sorting and paging; product pages with the
  full ingredient record, inherited warnings and allergen declarations;
  category and ingredient reference pages
- Admin catalogue: product list and editor, publishing checklist, categories,
  ingredients, media library, CMS editor, compliance review screen
- CMS pages as typed blocks with draft/publish separation
- SEO: per-entity metadata, structured data, canonical URLs, a database-driven
  sitemap that honours `noindex`
- Content-addressed object storage with a real S3 adapter and an isolated
  development filesystem adapter that production configuration refuses;
  uploads are decoded before they are trusted and stripped of EXIF

**The gate**

A product cannot be published without passing the publishing checklist. Thirteen
checks are declared; ten are evaluated now and three belong to later phases.
Those three report `NOT_YET_ENFORCED` and are listed explicitly — a checklist
that quietly counts unbuilt checks as passes looks like assurance it cannot
give. The gate is evaluated server-side at the transition, so a stale admin
screen cannot publish something that has since lost its approval, and it also
guards the move into `READY` (minus the compliance signature), so that status
means what it says.

Compliance approval is a separate authority: `ADMIN` deliberately lacks
`COMPLIANCE_APPROVE`. Decisions are append-only at the database level, snapshot
the checklist the reviewer saw, and lapse on a configured interval. Material
changes — the formulation, the manufacturer, the warnings, the label
photograph, or a new warning on any ingredient used — re-open the approval and
withdraw a live listing.

**Verified**

| Suite                     | Count | Against                  |
| ------------------------- | ----: | ------------------------ |
| Shared package unit tests |   194 | pure logic               |
| Storefront unit tests     |    45 | pure logic               |
| API unit tests            |    61 | pure logic               |
| Database integration      |    17 | real PostgreSQL          |
| API integration (e2e)     |   124 | real PostgreSQL + Redis  |
| Worker integration        |     9 | real PostgreSQL + BullMQ |

Both front ends were additionally exercised against the running API with a real
published product: the storefront listing, search, facets, product page,
structured data and sitemap; the admin catalogue, compliance queue and review
screen, signed in as a product manager and as an MFA-verified compliance
reviewer.

**Not done in Phase 2**

- Automated browser E2E (Playwright). Still verified against running services by
  hand; the harness has slipped again and should not slip a third time.
- Load testing. No performance claim is made anywhere.
- Product variants have a schema and an admin read view, but no editor. Nothing
  in Phase 2 needs one; Phase 3 does, because stock is held per variant.
- Claims and evidence. Phase 4. The gate already declares the two checks.

---

## Phase 3 — Commerce ✅ Complete

**Delivered**

- Cart for guests and signed-in customers, keyed by an httpOnly token cookie,
  merged into the customer's cart on sign-in
- A pure pricing engine over explicit inputs: integer minor units throughout,
  order-level discount and tax allocated across lines by largest remainder so
  line values always sum exactly to the order values
- Checkout as an idempotent state machine, created under a caller-supplied key
  behind a unique constraint; quotes carry a pricing fingerprint and a basket
  that moved underneath is refused rather than silently repriced
- A payment provider interface with a real Stripe Payment Intents adapter
  (SCA/3-D Secure) and an isolated development adapter that production
  configuration refuses to start with
- Signature-verified webhooks: constant-time comparison, a timestamp tolerance
  window, multiple signatures for secret rotation, the raw request body
  preserved on that route alone, and deduplication through a unique constraint
  on the provider's own event id
- Orders with an explicit state machine, stored totals, and an append-only
  timeline enforced by a database trigger
- Refunds capped at what the provider says remains captured, attributable to a
  named MFA-verified person with a written reason, idempotent by key, with
  optional restocking
- Inventory with warehouses, reservations and an append-only adjustment ledger;
  `SELECT … FOR UPDATE` row locks taken in a fixed order, and CHECK constraints
  that refuse negative stock regardless of what the application asks for
- Shipping rates as configuration, quoted server-side and re-derived before
  payment
- Storefront cart, staged checkout, order history and order detail; admin
  orders list and detail with the timeline, MFA-gated refunds, inventory,
  warehouses and shipping rates
- Scheduled sweeps that release expired reservations and expire abandoned
  checkouts, shared with the API so the scheduled code is the tested code

**The rules that shaped it**

**Stock is held before payment exists.** Reprice → verify fingerprint → reserve
stock → create the payment intent, in that order. Reversing the last two would
produce the one outcome that must never happen: money taken for goods that are
not there.

**The provider decides whether money moved**, never the browser. Completion
asks the provider or waits for a signature-verified webhook; the two paths
converge on the same idempotent handler.

**Card data never reaches this application.** No method on the provider
interface accepts a PAN, an expiry or a CVV, and there is no shape in which one
could be passed. The order screen shows only the brand and last four digits the
provider reports.

**Idempotency is a database constraint, not a check.** Checkouts, refunds and
webhook events are each unique on their key; a retry loses the insert rather
than passing a check that another request has already passed.

**Verified**

| Suite                     | Count | Against                  |
| ------------------------- | ----: | ------------------------ |
| Shared package unit tests |   229 | pure logic               |
| Storefront unit tests     |    45 | pure logic               |
| API unit tests            |    64 | pure logic               |
| Database integration      |    17 | real PostgreSQL          |
| API integration (e2e)     |   183 | real PostgreSQL + Redis  |
| Worker integration        |     9 | real PostgreSQL + BullMQ |

The commerce suite includes a three-way concurrent checkout race asserting that
exactly one wins and stock never goes negative, a forged webhook that is
refused, a replayed webhook that is deduplicated, a stale quote that is
refused, and a refund that fails at the provider and is then successfully
retried under the same key.

The whole purchase path was additionally walked against the running API: add to
cart, start checkout, restart it idempotently, price it, have a stale quote
refused, prepare it, have completion refused before payment, settle it with a
signed webhook, have a forged one rejected with 403 and a replay deduplicated,
place the order, repeat completion idempotently, and confirm the reservation
moved from the cart to the order as `COMMITTED`. The admin console was walked
the same way as an MFA-verified administrator.

**Not done in Phase 3**

- **Tax is configuration, not calculation.** US sales tax is
  origin/destination-dependent, jurisdiction-specific and product-category
  specific; getting it right is a tax-engine integration. Until that exists the
  rate is a configured fraction, and a deployment with none configured prices
  tax at zero _and reports `taxRateApplied: null`_, so "no tax" is
  distinguishable from "tax not calculated". No deployment should take real
  money without that integration.
- **Discount codes and promotions.** The pricing engine takes an order-level
  discount and allocates it correctly; nothing yet produces one.
- **Transactional email for orders.** Nothing sends an order confirmation,
  shipping notice or refund notice. The confirmation page deliberately does not
  claim one was sent. A guest reaches their order from the browser that placed
  it; reaching it from another device needs the email that does not exist yet.
- **Fulfilment.** Shipments have a schema and are shown on the order, but
  nothing creates them and no carrier is integrated. Stock therefore leaves
  `reserved` at cancellation or refund, never yet at shipment.
- **The Stripe adapter has not been exercised against Stripe.** It is written
  against the documented REST API and unit-tested against recorded shapes,
  including webhook signature verification. It has not run against a real
  Stripe account, and that is a prerequisite for taking real money.
- **Automated browser E2E (Playwright).** Both front ends are still verified
  against running services by hand. This has now slipped three phases.
- **Variant editor.** Phase 2 flagged this as needed by Phase 3. Stock is held
  per variant and the seeded catalogue has one variant per product, so it was
  not blocking; it is still missing.
- **Load testing.** No performance claim is made anywhere.

---

## Phase 4 — Compliance ✅ Complete

The reason this platform is custom rather than off the shelf.

**Delivered**

- Product claims as explicit, versioned records with a lifecycle
  (`DRAFT → EVIDENCE_REQUIRED → UNDER_REVIEW → APPROVED`), where approved
  wording is never overwritten — revising writes a new version and the approved
  one stays byte-for-byte as it was signed off
- Evidence as a shared library: source type, citation, population, dosage,
  duration, outcome and **limitations**, every field typed by the person who
  read the study
- Claim review with recorded sign-off by a named MFA-verified reviewer, against
  a named version, with the evidence file snapshotted into the decision
- Product and lot documents — certificates of analysis, GMP certificates, test
  reports — recorded as _stated by the uploader_ and never as verified
- Lots with manufacture and expiry dates, quantities and an append-only
  disposition history
- First-expiry-first-out allocation that excludes expired, quarantined and
  recalled stock, and refuses rather than shipping something unidentifiable
- Quarantine and release, each requiring a written basis that cannot be edited
- Recalls: opening one withdraws affected lots from sale immediately, derives
  which orders received them, and requires a separate, MFA-gated approval with a
  typed acknowledgement before a single customer identity is disclosed
- `CLAIMS_REVIEWED` and `EVIDENCE_REVIEWED` turned on, leaving no declared check
  unenforced
- Admin console for claims, evidence, lots and recalls; approved claims rendered
  on the storefront in their approved wording
- Hourly sweeps that expire lapsed claim approvals and withdraw out-of-date lots

**The rules that shaped it**

**Nothing is ever inferred.** A claim exists because a person wrote it down; the
system does not read marketing copy and decide it contains one. That inference
about regulated speech would fail in the direction nobody notices — the claim it
missed is exactly the one that goes out unreviewed. So the gate guarantees no
_recorded_ claim reaches a customer unapproved, and says so in those words
rather than letting a green tick imply more.

**Nothing is ever manufactured.** No evidence field is fetched from a DOI or
summarised from a title. No certificate is verified. No recall classification is
computed from a free-text reason. Each of those would be the software inventing
a regulatory fact, in the most convincing possible format.

**Approved history is never rewritten.** Claim versions, claim decisions, lot
events and recall actions are append-only, enforced by database triggers that
reject `UPDATE` and `DELETE` regardless of what the application asks for.

**Withdrawing stock is automatic; contacting customers is not.** Opening a
recall blocks the affected lots the moment somebody with the authority says so —
waiting on an approval to _stop selling_ would get the risk backwards. Telling
people they consumed a recalled product is the decision with legal consequences,
so it has its own permission (`RECALL_NOTIFY`), a second factor, a typed
acknowledgement, and a required written basis. Until it is given, the console
reports counts and withholds identities. **This system sends nothing to anyone.**

**Verified**

| Suite                     | Count | Against                  |
| ------------------------- | ----: | ------------------------ |
| Shared package unit tests |   252 | pure logic               |
| Storefront unit tests     |    45 | pure logic               |
| API unit tests            |    67 | pure logic               |
| Database integration      |    17 | real PostgreSQL          |
| API integration (e2e)     |   231 | real PostgreSQL + Redis  |
| Worker integration        |     9 | real PostgreSQL + BullMQ |

The compliance suite proves the properties the phase exists for: a product
manager and an administrator are each refused when they try to approve a claim;
an approved version survives a revision byte-for-byte and the unapproved text
never reaches the listing; a decision aimed at superseded wording is refused; a
disease claim cannot be approved however much evidence is attached;
contradictory evidence cannot substantiate a claim; FEFO picks the
earliest-expiring lot and skips quarantined, recalled and expired stock; a
lot-tracked item with no usable lot refuses to allocate rather than shipping
something unidentifiable; and a recall withholds every customer identity until a
named person with `RECALL_NOTIFY` approves contact — then discloses them, while
queueing nothing that could reach a customer.

**Not done in Phase 4**

- **Claim detection in free text.** The gate checks recorded claims; it does not
  scan descriptions for unrecorded ones, and deliberately does not try. A human
  compliance review is where someone attests the copy makes no claims beyond
  those recorded, and the checklist states that scope explicitly.
- **Automated substantiation judgement.** The system counts accepted supporting
  sources. It does not weigh whether a study supports a sentence — that is the
  reviewer's job, and a confidence score would look like the software had formed
  a view people would then rely on.
- **Recall notification dispatch.** Nothing is sent. Phase 5 added transactional
  email and deliberately did not wire recall notification to it: dispatch must
  remain a further explicit act rather than a consequence of approval.
- **Document verification.** A certificate's issuer and dates are recorded as
  claimed. Nothing checks them against a registry, and the API labels every
  document `NOT_VERIFIED_BY_THIS_SYSTEM` so no screen can imply otherwise.
- **Supplier and facility qualification**, and cGMP batch production records
  (21 CFR 111 subparts E and J). Lots are tracked; the manufacturing records
  behind them live in the manufacturer's systems.
- **Adverse event reporting** (serious adverse event reports under DSHEA).
  Not modelled.
- **Automated browser E2E (Playwright).** Still verified against running
  services by hand. Now four phases overdue.
- **Load testing.** No performance claim is made anywhere.

---

## Phase 5 — Customer lifecycle ✅ Complete

Accounts, reviews with verified-purchase status, coupons, subscriptions,
transactional email, support conversations.

**Delivered**

- Transactional email for the commerce lifecycle, dispatched from the
  append-only outbox through BullMQ: order placed, order cancelled, payment
  failed, refund issued, renewal failed, subscription unpaid, support replied
- Product reviews that are never visible on the strength of being written —
  every one is read by a moderator, and the response to the customer says so
- Verified-purchase status derived from the reviewer's **own** order line, never
  from a field on the request
- Review moderation with written reasoning required on every outcome,
  publication included, plus an adverse-event flag recorded independently of
  whether the text is published
- Discount codes priced entirely server-side: a request names a code, never an
  amount, and what the code is worth is recomputed on every repricing
- Redemption limits enforced by counting redemption rows under a row lock, not
  by a counter
- Subscriptions with recurring billing, off-session payment intents, bounded
  dunning, and a `PAST_DUE` state that is billable but not shippable
- One implementation of taking a recurring payment, in `@health/database`,
  called by both the API and the scheduled billing run
- Support conversations with staff internal notes excluded **in the query**, and
  a medical redirect shown before the customer types rather than after
- Account self-service: profile, consent history, a machine-readable data
  export, and a deletion request decided by a named person with MFA
- Storefront: reviews and ratings on product pages, a write-a-review flow,
  discount-code entry at checkout, subscription management, support threads and
  a privacy screen
- Admin console: moderation queue, discount codes, subscriptions, support inbox
  and the deletion-request queue

**The rules that shaped it**

**A review is not published by writing it.** There is no rating threshold that
auto-approves, and no phrase list that auto-rejects. Wording that often signals
a health claim puts a banner on the moderation screen and changes nothing else:
a word list cannot tell whether "it cured my headache" is a disease claim in
context, and code that acted on one would be making a regulatory decision by
substring match.

**The customer is told what will happen to their review.** A review that
silently never appears reads as a bug, and on a regulated product the moderation
is not something to be coy about.

**No client ever names a discount.** The code is the entire input. The amount is
looked up and recomputed server-side on every repricing, so there is no figure a
request could supply and no stale number to drift from the basket. Percentages
round **down**.

**A renewal charges the price the customer agreed to.** Item prices live on the
subscription and are not re-read from the catalogue. Charging more because a
catalogue price moved is changing the terms without asking, which US
auto-renewal statutes take a dim view of.

**Cancelling is one button.** No retention flow, no required reason, no waiting
period — each is a dark pattern the FTC has been explicit about, and the API
would not enforce them anyway.

**A failed renewal stops fulfilment immediately, and the retries are bounded.**
Shipping against a payment that did not settle is the subscription equivalent of
taking money for stock that is not there. When the schedule is exhausted the
subscription is left `UNPAID` rather than retried forever.

**Deleting an account does not delete the evidence.** Orders, payments, consent
history and the record of which lots the customer received are retained — the
last so a recall can still reach them, an obligation that does not lapse because
somebody closed their account. Reviews are anonymised rather than deleted, so a
published rating other customers rely on does not silently change.

**Verified**

| Suite                     | Count | Against                  |
| ------------------------- | ----: | ------------------------ |
| Shared package unit tests |   312 | pure logic               |
| Storefront unit tests     |    45 | pure logic               |
| API unit tests            |    67 | pure logic               |
| Database integration      |    17 | real PostgreSQL          |
| API integration (e2e)     |   275 | real PostgreSQL + Redis  |
| Worker integration        |     9 | real PostgreSQL + BullMQ |

The lifecycle suite proves the properties the phase exists for: a review is
`PENDING` the moment it is written and no published row exists; a verified badge
claimed against somebody else's order is refused rather than quietly dropped;
the published rating average excludes unmoderated text; a client-supplied
discount amount is ignored in favour of the coupon's own value; a percentage
rounds down; two concurrent checkouts racing for the last remaining redemption
produce exactly one winner; billing the same period three times produces one
charge; a declined renewal moves the subscription to `PAST_DUE` and stops
dispatch; the dunning schedule terminates at `UNPAID`; a cancelled or paused
subscription is never billed; an internal staff note never appears in the
customer's view of their own conversation; erasure keeps order, payment, consent
and lot history while anonymising reviews; and the scheduled billing run — the
real `listDueSubscriptions` followed by the real `billSubscriptionPeriod` —
collects a due renewal and finds nothing due on the next pass.

**Not done in Phase 5**

- **SMS.** The provider abstraction and a console adapter exist from Phase 1;
  no transactional message is sent over SMS, and nothing pretends one is.
- **Review replies and helpfulness voting.** Not modelled.
- **Subscription "skip this delivery".** Pause and resume exist; skipping a
  single period does not.
- **Changing what a subscriber pays.** A price change does not reach an existing
  subscription at all, because doing so needs the subscriber's agreement and
  that flow is not built. This is a deliberate omission, not an oversight: the
  alternative is silently charging more.
- **Proration.** Resuming starts a fresh period rather than back-charging for
  the paused time; there is no mid-period upgrade to prorate.
- **Coupon stacking**, BOGO and tiered promotions. One code per checkout.
- **A card-entry element.** Subscriptions bill a provider token the browser
  obtained by sending the card to the provider directly. With the development
  adapter there is no such step, and the storefront has no field for a card
  number by design — that is what keeps this application out of PCI DSS scope.
- **Automated browser E2E (Playwright).** Still verified against running
  services by hand. Now five phases overdue.
- **Load testing.** No performance claim is made anywhere.

---

## Phase 6 — Growth

First-party analytics, SEO automation, blog, landing pages, conversion tracking.

## Phase 7 — AI

Gateway, RAG over _approved_ knowledge only, content and SEO assistance,
analytics summarisation, guardrails and AI audit logs.

AI may draft, summarise and retrieve. It may never approve a claim, change
compliance status, invent evidence, diagnose, or issue a refund. Sensitive
actions produce a task for a human, never a completed action.

## Phase 8 — Production hardening

Load testing (the first point at which a performance number may be quoted),
security testing, browser E2E, backup _and restore_ drills, alerting review,
disaster recovery, performance work.

---

## Standing constraints

These do not change between phases.

1. No fake integration is ever presented as working. A mock adapter is isolated,
   named, and refused in production by the environment contract.
2. No unapproved health claim is published, by a human or by AI.
3. Audit and compliance history is append-only.
4. Payments, inventory and compliance changes are transactional.
5. Nothing is marked complete until it is verified against real infrastructure.
