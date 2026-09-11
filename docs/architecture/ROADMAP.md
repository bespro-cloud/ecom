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

## Phase 4 — Compliance 🔜 Next

The reason this platform is custom rather than off the shelf.

- Product claims with versioning; approved history is never overwritten
- Evidence records: study type, population, dosage, duration, outcome,
  limitations
- Compliance review workflow with recorded sign-off
- Product documents and certificates
- Batch and lot tracking with expiry dates
- FEFO allocation excluding expired, quarantined and recalled stock
- Quarantine and release
- Recall management: affected batches → orders → customers, with approval
  required before any customer is contacted

---

## Phase 5 — Customer lifecycle

Accounts, reviews with verified-purchase status, coupons, subscriptions,
transactional email and SMS, support conversations.

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
