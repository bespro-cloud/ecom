# Data retention

## Why the application cannot delete these records

`audit_logs` and `customer_consents` have database triggers that reject UPDATE
and DELETE. The application role has no way around them. That is deliberate:

- The value of a compliance record is entirely in its credibility. A record that
  _could_ have been quietly edited is not evidence.
- A bug, an ORM `updateMany` with a wrong filter, or a compromised service
  account cannot rewrite who approved what.

The cost is that legitimate retention becomes a manual, privileged operation.
That trade is the right way round.

## Setting retention periods

Retention periods are a **legal decision, not an engineering one**. Set them
with counsel, considering:

- Tax and financial record obligations (typically several years)
- Product liability limitation periods
- State privacy law, including deletion rights
- Regulatory substantiation expectations for claims and evidence

Once decided, record them here and implement them as a scheduled privileged job.

| Data                       | Period      | Basis                   |
| -------------------------- | ----------- | ----------------------- |
| Audit log                  | _to be set_ | Security and regulatory |
| Consent ledger             | _to be set_ | Proof of permission     |
| Claim and evidence history | Indefinite  | Substantiation          |
| Recall records             | Indefinite  | Regulatory              |
| Order and payment records  | _to be set_ | Tax law                 |
| Sessions and tokens        | 60 days     | Already automated       |
| Analytics events           | _to be set_ | Business need           |

Sessions and expired tokens are already pruned by the worker's maintenance jobs.
Everything marked _to be set_ is currently retained indefinitely, which is the
safe default but not a permanent answer.

## Running a retention job

A privileged, deliberate, out-of-band operation. Not something the application
can trigger.

```sh
# 1. Back up first. Non-negotiable — this deletes regulatory records.
./scripts/backup.sh pre-retention-$(date -u +%Y%m%d)

# 2. Confirm what would be removed, before removing it.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT count(*), min(created_at), max(created_at)
    FROM audit_logs
   WHERE created_at < now() - interval '<agreed period>';"

# 3. Delete, as a superuser, with the trigger suspended for the transaction
#    only. Note the session_replication_role trick: it is scoped to this
#    session and reverts on disconnect.
docker compose exec postgres psql -U postgres -d "$POSTGRES_DB" <<'SQL'
BEGIN;
SET LOCAL session_replication_role = 'replica';  -- suspends user triggers
DELETE FROM audit_logs WHERE created_at < now() - interval '<agreed period>';
COMMIT;
SQL

# 4. Confirm the triggers are active again.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal;"
```

`tgenabled` must read `O`.

## Recording it

Every retention run is itself an event worth recording — outside the table being
pruned. Keep a log with:

- Date and operator
- Table and period applied
- Row count removed
- The backup taken beforehand
- The authority for the period (which policy, approved by whom)

## Customer deletion requests

A deletion request under state privacy law does **not** override a legal
retention obligation, and the two frequently conflict. Work through it with
counsel; the usual shape is:

1. Delete or anonymise the profile and marketing data.
2. Retain order and payment records required by tax law, reduced to the minimum
   fields.
3. Retain the consent ledger as proof of what was permitted and when — deleting
   it would destroy the evidence that the person's earlier preferences were
   honoured.
4. Retain audit records; they concern actions taken, not the person's profile.
5. Record the request, the decision and the reasoning.

The schema supports this: `customers` and `customer_addresses` carry
`deleted_at`, while financial and compliance records do not. Soft deletion is
deliberately available only where erasure is safe.
