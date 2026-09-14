# Deployment

## Local development

```sh
git clone <repository> && cd health-commerce
./scripts/dev.sh
```

That script creates `.env` with freshly generated development keys, starts
PostgreSQL, Redis and MinIO, applies migrations, seeds development data, and
runs every app in watch mode.

| Service    | URL                            |
| ---------- | ------------------------------ |
| Storefront | http://localhost:3000          |
| Admin      | http://localhost:3001          |
| API        | http://localhost:4000/api/v1   |
| API docs   | http://localhost:4000/api/docs |
| MinIO      | http://localhost:9001          |

### Development accounts

Created by the seed, clearly labelled, and refused entirely when
`NODE_ENV=production`:

| Account                | Role                |
| ---------------------- | ------------------- |
| `superadmin@dev.local` | SUPER_ADMIN         |
| `admin@dev.local`      | ADMIN               |
| `compliance@dev.local` | COMPLIANCE_REVIEWER |
| `product@dev.local`    | PRODUCT_MANAGER     |
| `orders@dev.local`     | ORDER_MANAGER       |
| `warehouse@dev.local`  | WAREHOUSE_MANAGER   |
| `support@dev.local`    | SUPPORT_AGENT       |
| `customer@dev.local`   | CUSTOMER            |

Passwords are printed by the seed. The privileged ones must enrol MFA on first
sign-in — that is the same code path production uses, so it is worth walking
through once.

### Useful commands

```sh
pnpm dev                  # everything, watch mode
pnpm build                # everything
pnpm test                 # unit tests
pnpm test:integration     # integration tests (needs PostgreSQL + Redis)
pnpm lint
pnpm typecheck

pnpm db:migrate           # create and apply a migration
pnpm db:migrate:deploy    # apply pending migrations
pnpm db:seed              # development fixtures
pnpm db:reset             # DESTRUCTIVE: drop, recreate, migrate, seed
pnpm db:studio            # browse the database
```

## Server preparation

Ubuntu 22.04 or 24.04 LTS, 4 vCPU / 8 GB / 100 GB SSD as a starting point.

```sh
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"

# Firewall: only HTTP/HTTPS and SSH
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Application directory
sudo mkdir -p /opt/health-commerce
sudo chown "$USER" /opt/health-commerce
```

Harden SSH: key authentication only, no root login, no password authentication.

## Configuration

Production configuration comes from a secret manager, injected at container
start. Do not put real secrets in a file on the host.

```sh
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
```

The API validates every variable at boot and **refuses to start** rather than
run with an unsafe default. It will not start in production with:

- the mock payment or fulfilment provider
- the console email provider
- `COOKIE_SECURE=false`
- an empty or wildcard CORS allow-list
- a plaintext (`http://`) public URL
- key material under 32 bytes
- a real payment provider with no webhook secret
- the filesystem storage provider, or S3 storage with no bucket
- the development AI stand-in
- a real AI provider with no API key, or any enabled AI provider with no daily
  budget

`scripts/verify-production-guards.mjs` asserts these in CI, so a guard rail
cannot be quietly removed.

### AI

AI assistance is optional. `AI_PROVIDER=disabled` is a fully supported
production configuration and the console says so rather than showing a broken
feature.

| Variable                 | Notes                                            |
| ------------------------ | ------------------------------------------------ |
| `AI_PROVIDER`            | `disabled`, `development` or `anthropic`         |
| `AI_API_KEY`             | Required for `anthropic`                         |
| `AI_MODEL`               | Model identifier                                 |
| `AI_TIMEOUT_MS`          | Per-request timeout                              |
| `AI_DAILY_BUDGET_MICROS` | Must be non-zero when enabled                    |
| `AI_RATE_LIMIT_PER_HOUR` | Per staff member                                 |
| `AI_INPUT_PRICE_MICROS`  | Price per million input tokens, for cost records |
| `AI_OUTPUT_PRICE_MICROS` | Price per million output tokens                  |

`development` is the stand-in used to exercise the guardrails and the audit
trail without an API key. It is refused in production for the same reason the
mock payment provider is: output that is not from a model must never be mistaken
for output that is.

An enabled provider with `AI_DAILY_BUDGET_MICROS=0` is refused at boot. A
feature that calls a metered API with no ceiling is an incident waiting for a
retry loop, and the limit is cheaper to set than to discover.

## TLS

```sh
sudo certbot certonly --standalone \
  -d shop.example.com -d admin.example.com -d api.example.com
```

Place certificates at `/etc/nginx/certs/<service>/{fullchain,privkey,chain}.pem`.
nginx does not expand environment variables, so substitute the hostnames:

```sh
envsubst '${STOREFRONT_HOST} ${ADMIN_HOST} ${API_HOST}' \
  < conf.d/storefront.conf > /etc/nginx/conf.d/storefront.conf
```

## Deploying

CI builds images once and tags them with the commit sha. The same artefact goes
to staging and then production — nothing is rebuilt in between, so what passed
staging is what customers get.

```sh
./scripts/deploy.sh production <image-tag>
```

Order of operations, and why:

1. **Pull images.** A registry problem fails before anything on the host changes.
2. **Back up the database.** A migration without a restorable backup is a gamble.
3. **Run migrations.** Before the new code starts — so the version currently
   serving keeps working against the new schema.
4. **Sync reference data.** Roles, permissions and settings. Idempotent, creates
   no accounts.
5. **Roll services one at a time**, waiting for health between each.
6. **Reload nginx** after validating its configuration.
7. **Smoke test.** Read-only and unauthenticated, safe against production.

### Migrations must be backward compatible

Because migrations run _before_ the new code, the old code has to survive the
new schema for the length of a rollout. That means:

| Do                                      | Do not                                  |
| --------------------------------------- | --------------------------------------- |
| Add a nullable column                   | Add a `NOT NULL` column with no default |
| Add a table or an index concurrently    | Rename a column in one step             |
| Backfill in a separate, later migration | Drop a column still referenced          |
| Widen a type                            | Narrow a type                           |

Renaming a column takes three deploys: add the new one and write to both; backfill
and switch reads; drop the old one. Slower, but a rollback never breaks.

**Never edit a migration that has been applied anywhere.** Write a new one.

### Rolling back

Code rolls back by redeploying the previous tag with `--skip-migrations`. The
schema does not roll back — that is exactly why migrations are written to be
backward compatible.

If a migration must be undone, write a forward migration that reverses it, and
test it against a restored backup first.

## Backups

Automated daily, and before every production deploy.

Backups are encrypted with `age` **before leaving the host**, so the object
store never holds readable customer data. The script refuses to run without a
recipient key, and refuses to store a dump that is implausibly small (which is
how a partial `pg_dump` usually presents itself).

```sh
./scripts/backup.sh                      # encrypted, uploaded
./scripts/restore.sh <name> [target-db]  # restores to a NEW database
```

`restore.sh` will not restore over the live database. Restore, verify, then
promote deliberately.

> A backup that has never been restored is a hypothesis. Run the quarterly
> drill in [../operations/RUNBOOK.md](../operations/RUNBOOK.md#restore-drill).

## Scaling

**Vertically** first — it is cheaper and simpler than most teams admit.

**Horizontally**, in this order:

1. More API instances. It is stateless; sessions live in PostgreSQL and rate
   limits in Redis, so limits stay global.
2. More storefront instances behind nginx.
3. More worker instances. The outbox uses `SELECT … FOR UPDATE SKIP LOCKED`, so
   they will not double-dispatch.
4. A PostgreSQL read replica for reporting.
5. OpenSearch behind the existing search interface.

Do not quote a capacity figure until Phase 8 measures one.

## Monitoring

```sh
cd infrastructure/monitoring
docker compose -f docker-compose.monitoring.yml up -d
```

Prometheus scrapes `/health/metrics` on the API and worker. Neither Prometheus
nor Grafana is exposed publicly; reach them over a VPN or an SSH tunnel.

Alerts are defined in `prometheus/rules/alerts.yml` and every one of them points
at a runbook section. An alert nobody can act on is noise.

## Environment checklist

- [ ] Secrets generated and stored in the secret manager
- [ ] TLS certificates issued and auto-renewal tested
- [ ] Firewall restricted to 22/80/443
- [ ] SSH keys only, root login disabled
- [ ] Database and Redis publish no ports
- [ ] Backups running and a restore drill completed
- [ ] Monitoring scraping, alerts routed to a real destination
- [ ] Sentry DSN configured
- [ ] Admin console restricted by IP or VPN
- [ ] Cloudflare configured, origin not directly reachable
- [ ] `verify-production-guards.mjs` passing in CI
- [ ] AI either disabled, or configured with a real provider, a key and a daily
      budget
