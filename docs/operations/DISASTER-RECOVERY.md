# Disaster recovery

What to do when the platform, or the data under it, is gone rather than merely
unwell. For the unwell case see [RUNBOOK.md](RUNBOOK.md).

## Status: this plan has never been executed

Stated first, because it is the most important fact in the document.

**No restore drill has been run against this platform, on any topology.** Every
recovery time below is an *estimate*, not a measurement. Until a drill is run
and timed, treat them as the order of magnitude to plan around and not as a
commitment anyone should make to a customer, an auditor or an insurer.

A backup that has never been restored is a hypothesis. Phase 8 exists to turn
these numbers into measurements; it is not finished.

## Objectives, and what they currently are

| | Target | Actual today | Gap |
| --- | --- | --- | --- |
| **RPO** — data you can afford to lose | 15 minutes | **Up to 24 hours** | No continuous archiving |
| **RTO** — time to serving again | 1 hour | Unmeasured | No drill has been timed |

**The RPO gap is the most serious problem in this document.** `scripts/backup.sh`
runs daily and before each deploy. Restoring from it therefore loses up to a
day of everything:

- **Orders and payments.** Money taken with no record of the order it paid for.
  Customers charged for things the platform no longer knows it sold.
- **Audit and compliance history.** These tables are append-only precisely
  because they are a regulatory record. A day of claim approvals, evidence
  decisions, recall actions and consent changes vanishing is not an operational
  inconvenience; it is a hole in the record you are required to keep.
- **Customer consent changes.** Someone who withdrew marketing consent
  yesterday has, after the restore, consented again as far as the system knows.

Closing it needs continuous WAL archiving with point-in-time recovery, so
recovery lands seconds rather than hours behind. On the Render topology this
means a Postgres plan with PITR (which is why `render.yaml` does not specify the
free tier). On the compose topology it means WAL shipping to object storage.
**Neither is configured yet.** Until one is, the honest RPO is 24 hours and
should be written down as such wherever a commitment is made.

## What backups do and do not cover

`scripts/backup.sh` dumps PostgreSQL, encrypts it with `age` before it leaves
the host, and uploads it. That covers every table — the commerce, compliance and
audit record.

It does **not** cover:

- **Object storage.** Product images, compliance documents and evidence files
  live in S3 (or MinIO locally) and are not in the dump. A restored database
  will reference media that may no longer exist. Enable bucket versioning and
  cross-region replication; neither is set up by this repository.
- **Redis.** Rate-limit counters and in-flight queue state. Losing it is
  tolerable by design — the outbox lives in PostgreSQL and drains when Redis
  returns — but jobs already handed to BullMQ and not yet completed are lost.
- **Secrets.** See below; this is the scenario most likely to be overlooked.

## The scenario nobody plans for: losing `ENCRYPTION_KEY`

`ENCRYPTION_KEY` protects staff TOTP secrets at rest with AES-256-GCM. It is not
in the database and not in the backup — correctly, since a backup containing the
key that decrypts it protects nothing.

If that key is lost, the encrypted TOTP secrets are unrecoverable. Every
privileged staff member is locked out of MFA, and every privileged role requires
MFA, so **nobody can administer the platform** — including the people who would
re-enrol everyone.

Recovery means: restore the key from escrow. There is no other path that does
not involve a database-level intervention to clear MFA factors for every staff
account, which is itself a security event.

**Therefore:** `SESSION_SECRET` and `ENCRYPTION_KEY` must be escrowed
separately from the backups and separately from the secret manager that serves
them, with at least two people able to retrieve them. Losing the secret manager
and the backups together must not be the same event as losing the keys.

## Scenarios

### Host or instance loss

*The server is gone. Data volumes may or may not survive.*

- **Detect:** `ServiceDown`, scrapes stop.
- **Decide:** rebuild, do not repair. A host in an unknown state after a failure
  is not a host to run a payments platform on.
- **Recover:** provision, restore the latest backup into a new database, deploy
  the last known-good image tag, point DNS.
- **Lost:** up to 24 hours (see RPO above).

### Database corruption

*PostgreSQL is running and returning wrong or unreadable data.*

- **Detect:** `HighErrorRate` with `DEPENDENCY_UNAVAILABLE`, constraint
  violations that should be impossible, `AuditWriteFailure`.
- **Decide:** stop writes first. A corrupt database taking new orders makes the
  eventual restore worse with every minute.
- **Recover:** restore to a *new* database (`scripts/restore.sh` refuses to
  restore over the live one for exactly this reason), verify, then promote.
- **Watch for:** corruption that predates the newest backup. Check several
  restore points before assuming the latest is clean.

### Accidental destructive migration

*A migration dropped or rewrote something it should not have.*

- **Detect:** usually a person, immediately after a deploy.
- **Decide:** the schema does not roll back. Never edit an applied migration.
- **Recover:** `scripts/deploy.sh production <previous-tag> --skip-migrations`
  restores the code; then write a *forward* migration that reverses the damage
  and test it against a restored copy before running it anywhere real.
- **Note:** the pre-deploy backup exists for this. It is why `deploy.sh` takes
  one before migrating.

### Ransomware or a malicious insider

*Data encrypted or deliberately destroyed, possibly including backups.*

- **Detect:** mass unexpected changes, unfamiliar admin actions in the audit
  log, backups failing or disappearing.
- **Decide:** assume credentials are compromised. Rotate before restoring, or
  you restore into the attacker's continued access.
- **Recover:** restore from the oldest backup known to predate the compromise,
  then roll forward selectively.
- **Depends on:** backup immutability. Object-lock or versioned, write-once
  storage so an attacker holding production credentials cannot delete the
  backups too. **Not configured by this repository** — it is the single change
  that most improves the survivability of this scenario.

### Region loss

*The whole hosting region is unavailable.*

- **Recover:** requires backups stored in a different region from the database,
  and a documented decision about which region to rebuild in.
- **Reality:** this is a multi-hour recovery and nothing here shortens it. Say
  so rather than implying otherwise.

### Credential compromise

*A key, token or provider secret is known to have leaked.*

- Rotate `SESSION_SECRET` — every access token becomes invalid immediately,
  which signs everybody out. That is the intended blast radius.
- Rotate payment, email, storage and 3PL credentials at the provider.
- Do **not** rotate `ENCRYPTION_KEY` without a re-encryption pass over stored
  TOTP secrets; see above.
- Review the audit log for the window of exposure. It is append-only, so it is
  trustworthy even if the attacker had database access.

### Payment provider outage

*Not a disaster, but the scenario most likely to actually happen.*

Checkout fails at the payment step. Orders are not lost — they sit in
`PENDING_PAYMENT`. Webhook handling is idempotent by provider event id, so the
provider's own redelivery reconciles everything when it returns. Do not
hand-edit orders to "fix" this.

## Before any of this can be relied on

- [ ] Continuous WAL archiving / PITR configured — closes the 24-hour RPO
- [ ] Backups stored in a different region from the database
- [ ] Backup storage immutable (object lock or versioning)
- [ ] `SESSION_SECRET` and `ENCRYPTION_KEY` escrowed, retrievable by ≥2 people
- [ ] Object storage versioned and replicated
- [ ] **A restore drill run end to end and timed**, turning the RTO estimate
      into a measurement
- [ ] Alerting on backup freshness — see the known-gaps note in
      `infrastructure/monitoring/prometheus/rules/alerts.yml`. Today a backup
      that stops running is discovered on the day it is needed.
- [ ] This document re-read after the drill, with the estimates replaced by
      real numbers

Until every box is ticked, this is a plan rather than a capability.
