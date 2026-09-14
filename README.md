# Health Commerce

A custom commerce platform for selling compliant healthcare and wellness
products in the United States.

The compliance model — claims, evidence, batch traceability, recalls — is part
of the domain rather than something bolted on afterwards. That is the reason
this is a custom platform and not a theme on a hosted cart.

**Status: Phases 1–6 complete.** Identity and RBAC; the catalogue with its
publishing gate; cart, checkout, payments, orders, refunds, shipments, returns
and inventory; claims, evidence, lot traceability and recalls; and the customer
lifecycle of reviews, discount codes, subscriptions, support and account
self-service; and first-party analytics, a compliance-gated blog, automatic
redirects and SEO tooling. AI (Phase 7) and production hardening (Phase 8) are next. See [docs/architecture/ROADMAP.md](docs/architecture/ROADMAP.md) for
exactly what exists and what does not — including what each phase deliberately
did **not** build, and why.

## Getting started

```sh
./scripts/dev.sh
```

Generates development keys, starts PostgreSQL, Redis and MinIO, applies
migrations, seeds development data and runs everything in watch mode.

| Service    | URL                            |
| ---------- | ------------------------------ |
| Storefront | http://localhost:3000          |
| Admin      | http://localhost:3001          |
| API        | http://localhost:4000/api/v1   |
| API docs   | http://localhost:4000/api/docs |

The seed prints its development accounts. The privileged ones must enrol MFA on
first sign-in — the same path production uses, and worth walking once.

## Layout

```
apps/
  api/          NestJS. The domain.
  worker/       Outbox dispatch, queues, scheduled jobs.
  storefront/   Next.js. Customer-facing.
  admin/        Next.js. Staff console.

packages/
  database/     Prisma client, migrations, seeds, RBAC sync.
  types/        Permissions, roles, error codes, domain events.
  validation/   Zod schemas shared by the API and both front ends.
  config/       Environment contract, clock, log redaction.
  auth/         Hashing, tokens, TOTP, envelope encryption.
  notifications/ Email and SMS abstraction plus templates.
  ui/           Shared accessible React primitives.
```

## Commands

```sh
pnpm dev                # everything, watch mode
pnpm build              # everything
pnpm test               # unit tests
pnpm test:integration   # integration tests (needs PostgreSQL + Redis)
pnpm lint
pnpm typecheck

pnpm db:migrate         # create and apply a migration
pnpm db:seed            # development fixtures
pnpm db:studio          # browse the database
```

## A few decisions, up front

**The browser never talks to the API directly.** Both front ends proxy through
their own origin, so auth cookies stay first-party and `httpOnly`, CORS does not
arise, and an XSS payload has no token to steal.

**Permissions, not roles, in authorisation checks.** Roles group permissions;
guards test permissions. System roles live in code and are reconciled on deploy,
so a compromised admin session cannot quietly widen one.

**`ADMIN` cannot approve health claims.** Only `COMPLIANCE_REVIEWER` can, with
MFA. Separating that duty is the point of having a review process.

**The database enforces what the application promises.** Audit and consent
records reject UPDATE and DELETE at the database level. Uniqueness that must
hold under concurrency is a constraint, not an application check.

**Domain events are transactional.** Written in the same transaction as the
state change, then dispatched to queues by the worker. A customer is never
created without their welcome email being scheduled, and an email is never sent
for a registration that rolled back.

**Nothing fake is presented as working.** Mock providers exist for development,
are named as such, and the environment contract refuses to start production with
one.

## Documentation

| Document                                          | Covers                                |
| ------------------------------------------------- | ------------------------------------- |
| [Architecture](docs/architecture/ARCHITECTURE.md) | Shape, decisions, scaling             |
| [Roadmap](docs/architecture/ROADMAP.md)           | Phases; what is built and what is not |
| [Security](docs/security/SECURITY.md)             | Controls, and the gaps                |
| [Compliance](docs/compliance/COMPLIANCE.md)       | Regulatory model and its limits       |
| [Deployment](docs/deployment/DEPLOYMENT.md)       | Environments, migrations, rollback    |
| [API](docs/api/API.md)                            | Endpoints, conventions, error codes   |
| [Runbook](docs/operations/RUNBOOK.md)             | What to do when an alert fires        |
| [Retention](docs/operations/RETENTION.md)         | Why deletion is deliberately hard     |

## Legal note

This software provides technical compliance controls. It does not make a
business legally compliant. Product classification, labelling, claims,
advertising, manufacturing, privacy, tax and shipping obligations must be
reviewed by qualified US counsel against your actual products and business model
before you sell anything.
