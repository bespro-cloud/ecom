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

## Phase 2 — Catalogue and content 🔜 Next

- Products, variants, images, attributes
- Categories and the category tree
- Ingredients, sources, warnings, allergens
- Product search (PostgreSQL full-text behind a swappable interface)
- Product detail and listing pages
- Admin product management
- CMS pages with draft/publish
- SEO foundation: metadata, structured data, sitemap, canonical URLs
- S3 media pipeline with image optimisation

**Gate:** a product cannot be published without passing the compliance checklist
(Phase 4 supplies the checklist; Phase 2 builds the gate that consults it).

---

## Phase 3 — Commerce

- Cart (guest and authenticated, with merge on sign-in)
- Server-side pricing — client totals are never trusted
- Checkout with an idempotent state machine
- Payment provider abstraction; card data never reaches this application
- Verified, idempotent payment webhooks
- Orders with an explicit state machine
- Refunds
- Inventory, reservations and warehouses
- Shipping rates and the fulfilment provider interface

---

## Phase 4 — Compliance

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
