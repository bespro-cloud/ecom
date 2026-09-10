# Architecture

## What this is

A custom commerce platform for selling compliant healthcare and wellness
products to customers in the United States. It is not a storefront bolted onto
a generic cart: the compliance model — claims, evidence, batch traceability,
recalls — is part of the domain, not an afterthought.

## Shape

A **modular monolith**, deployed as four processes:

| Process      | Responsibility                                            |
| ------------ | --------------------------------------------------------- |
| `api`        | The whole domain. REST, versioned at `/api/v1`.           |
| `worker`     | Outbox dispatch, queue processing, scheduled maintenance. |
| `storefront` | Customer-facing Next.js app.                              |
| `admin`      | Staff console, also Next.js.                              |

### Why a monolith

At this stage, the cost of microservices — distributed transactions, network
failure between every boundary, four deployment pipelines — buys nothing. The
things this platform must get exactly right (inventory allocation, payment
state, compliance approval) are precisely the things that are hardest to make
correct across a network.

Module boundaries are enforced in code instead: each domain has its own service
layer, and no module reaches into another's tables. When one module genuinely
needs to become its own service, the boundary already exists and the extraction
is mechanical.

## Repository layout

```
apps/
  api/          NestJS. One module per domain.
  worker/       Outbox dispatcher, BullMQ processors, cron jobs.
  storefront/   Next.js App Router. Server components by default.
  admin/        Next.js App Router. No public surface.

packages/
  database/     Prisma client, migrations, seeds, RBAC sync.
  types/        Permission and role catalogues, error codes, domain events.
  validation/   Zod schemas shared by API and both front ends.
  config/       Environment contract, clock, log redaction.
  auth/         Password hashing, tokens, TOTP, envelope encryption.
  notifications/ Email and SMS provider abstraction plus templates.
  ui/           Shared accessible React primitives.

prisma/         schema.prisma and migrations (single source of truth).
infrastructure/ Dockerfiles, nginx, Prometheus, Grafana.
docs/           This.
```

## Request path

```
Browser
  │  first-party HTTPS only
  ▼
nginx  ── TLS, security headers, coarse rate limiting
  │
  ▼
Next.js (storefront / admin)
  │  server component renders, or /api/proxy forwards
  │  cookies forwarded verbatim; tokens never enter browser JavaScript
  ▼
NestJS API
  │  RateLimit → CSRF → JwtAuth → Permissions
  ▼
PostgreSQL ◄── the only durable state
Redis      ◄── rate limits, MFA nonces, queues (never a source of truth)
```

The browser never addresses the API directly. Both front ends proxy through
their own origin, which keeps auth cookies first-party, removes CORS from the
picture, and means an XSS payload has no token to steal.

## Backend module layout

```
apps/api/src/
  common/            errors, filters, guards, decorators, pipes, pagination
  infrastructure/    config, prisma, redis, logger, metrics, outbox
  modules/
    auth/            sessions, MFA, credentials, principals
    users/           staff administration
    customers/       customer self-service
    addresses/       address book
    rbac/            roles, permissions, privileged-role cache
    settings/        system settings, feature flags
    audit/           the append-only trail
    health/          probes and metrics
```

Later phases add `products/`, `inventory/`, `orders/`, `payments/`,
`compliance/`, `claims/`, `evidence/`, `recalls/`, `ai/` in the same shape.

## Decisions worth stating

### Money is never a float

Integer minor units plus an ISO currency code. `0.1 + 0.2 !== 0.3` is not an
acceptable property for an order total.

### Time is injected

Every service that cares about expiry takes a `Clock`. Session rotation, token
TTLs, lockout windows and audit timestamps are therefore deterministic under
test rather than dependent on sleeps. An ESLint rule forbids bare `new Date()`
in server code.

### The database enforces what the application claims

Where a rule must hold regardless of application bugs, it lives in the schema:

- `audit_logs` and `customer_consents` have triggers rejecting UPDATE and DELETE.
- One default shipping address per customer is a partial unique index, not an
  application check that two concurrent requests could both pass.
- Webhook idempotency is `UNIQUE (provider, external_id)`.
- Email uniqueness is on a normalised column, so `Alice@x.com` and `alice@x.com`
  cannot become two accounts.

### The transactional outbox

Domain events are written in the same transaction as the state change that
produced them. The worker polls with `SELECT ... FOR UPDATE SKIP LOCKED` and
dispatches to BullMQ with a job id derived from the row id.

Consequences: a customer is never created without their welcome email being
scheduled; an email is never sent for a registration that rolled back; and a
crash between "job added" and "row marked dispatched" re-adds an identical job
id, which BullMQ ignores.

### Permissions, never roles, in authorisation checks

Guards test permissions. Roles are only a way of grouping them. Removing a
permission from a role takes effect for everyone at their next token issue, with
no back-fill and no code change.

System roles are defined in `packages/types/src/roles.ts` and reconciled on
deploy. The API can read them but cannot edit them — so a compromised admin
session cannot quietly widen `SUPER_ADMIN`.

### Separation of compliance duty

`ADMIN` deliberately does **not** hold `CLAIM_APPROVE` or `COMPLIANCE_APPROVE`.
Only `COMPLIANCE_REVIEWER` (and `SUPER_ADMIN`) can sign off a health claim, and
only with MFA satisfied. An operational administrator being able to approve a
medical claim would defeat the point of having a review process.

## Scaling

What is ready now:

- The API is stateless; all session state is in PostgreSQL. Add instances freely.
- Rate limiting is in Redis, so limits are global rather than per-process.
- The outbox uses `SKIP LOCKED`, so worker instances can be added without
  double-dispatch.
- Search sits behind an abstraction so PostgreSQL full-text can be replaced by
  OpenSearch without touching the commerce domain.

What is not yet proven: **no load testing has been done.** No throughput or
concurrency figure is claimed anywhere in this repository, and none should be
until Phase 8 measures it.

## Related documents

- [ROADMAP.md](ROADMAP.md) — phases and what is actually built
- [../security/SECURITY.md](../security/SECURITY.md)
- [../compliance/COMPLIANCE.md](../compliance/COMPLIANCE.md)
- [../deployment/DEPLOYMENT.md](../deployment/DEPLOYMENT.md)
- [../api/API.md](../api/API.md)
- [../operations/RUNBOOK.md](../operations/RUNBOOK.md)
