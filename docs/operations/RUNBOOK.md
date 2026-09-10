# Runbook

Every alert in `infrastructure/monitoring/prometheus/rules/alerts.yml` points at
a section here. An alert without a response is noise.

## First moves, whatever the incident

```sh
cd /opt/health-commerce
docker compose ps
curl -sS https://api.example.com/health | jq
docker compose logs --tail 200 api
```

Every log line and error response carries a `correlationId`. Take it from the
user's report and grep for it — that is the fastest route from "a customer says
X" to the actual failure.

---

## Service down

**Alert:** `ServiceDown` — no scrape response for 2 minutes.

1. `docker compose ps` — is the container running or restarting?
2. `docker compose logs --tail 200 <service>` — a boot failure or a crash?
3. **Exit code 78** means the environment contract rejected the configuration.
   The message names the variable. Fix it in the secret manager and redeploy;
   do not work around the check.
4. Out of memory shows as exit 137. Check `docker stats`, then the memory limit
   in `docker-compose.prod.yml`.
5. If the process is alive but not serving, check `/health/ready` — a dependency
   is probably down; see below.

---

## Elevated error rate

**Alert:** `HighErrorRate` — over 2% of requests failing for 5 minutes.

```sh
docker compose logs --since 15m api | grep '"level":50' | tail -50
```

Group by `code`. Then:

- Mostly `DEPENDENCY_UNAVAILABLE` → the database or Redis. See below.
- Mostly `INTERNAL_ERROR` → a code fault. Sentry will have the stack trace.
  Consider rolling back to the previous tag.
- Concentrated on one route → a recent change to that path.
- Started exactly at a deploy → roll back first, diagnose after.

```sh
./scripts/deploy.sh production <previous-tag> --skip-migrations
```

---

## Database unavailable

1. `docker compose ps postgres` and `docker compose logs --tail 100 postgres`
2. Connection exhaustion is the usual cause:

```sql
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
SELECT pid, now() - query_start AS duration, left(query, 120)
  FROM pg_stat_activity
 WHERE state = 'active' AND now() - query_start > interval '30 seconds'
 ORDER BY duration DESC;
```

3. Terminate a genuinely stuck query with `pg_terminate_backend(pid)` — and note
   what it was, because it will happen again.
4. Disk full is the other common cause: `df -h`. WAL growth usually means
   archiving has stopped.

---

## Redis unavailable

Redis holds rate-limit counters, MFA challenge nonces and the queues. Losing it
degrades throughput protection and stalls background work; it does not lose
committed data — outbox rows are in PostgreSQL and will drain when Redis
returns.

The rate limiter deliberately fails **open** so a cache outage does not take the
whole API down. Expect a logged warning per request until it recovers.

```sh
docker compose logs --tail 100 redis
docker compose exec redis redis-cli INFO stats | head -30
docker compose exec redis redis-cli INFO memory | grep used_memory_human
```

`maxmemory-policy` is `noeviction` on purpose: silently evicting a queued job
would be worse than refusing the write.

---

## Refresh token reuse

**Alert:** `RefreshTokenReuseDetected` — fires on a single occurrence.

A consumed refresh token was presented again. Either a token was stolen, or a
client is misbehaving. The system has already revoked the whole session family.

1. Find the audit record:

```sql
SELECT * FROM audit_logs
 WHERE action = 'auth.token.reuse_detected'
 ORDER BY created_at DESC LIMIT 20;
```

2. Look at the account's recent history — sign-in locations, password changes,
   MFA changes.
3. One event for one user with no other signal is usually a client bug (an
   over-eager retry). A pattern across accounts is an incident.
4. If it looks like theft: revoke the user's sessions, contact them, and require
   a password reset.

```sh
# As an operator, via the admin console, or:
POST /api/v1/users/:id/revoke-sessions
```

5. If many accounts are affected, rotate `SESSION_SECRET`. Every access token
   becomes invalid immediately.

---

## Audit write failure

**Alert:** `AuditWriteFailure`

The audit trail could not be written. This is a regulatory record, so treat it
as a serious incident even if customers notice nothing.

1. Almost always the database: check disk, connections and the `audit_logs`
   table specifically.
2. If someone has changed the append-only triggers, that is itself an incident —
   the application is _supposed_ to be unable to update or delete these rows.

```sql
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal;
```

`tgenabled` must be `O`. If it is `D`, someone disabled it; find out who and
re-enable it.

3. Record the window during which auditing failed. A gap that is documented is
   recoverable; a gap that is discovered later is not.

---

## Outbox backlog

**Alert:** `OutboxBacklog` — over 500 undispatched rows for 10 minutes.

The dispatcher is not draining. Nothing is lost — rows are durable — but emails
and downstream work are not happening.

```sql
SELECT event_type, count(*), min(created_at) AS oldest
  FROM outbox_messages
 WHERE dispatched_at IS NULL AND failed_at IS NULL
 GROUP BY event_type ORDER BY count DESC;

SELECT id, event_type, attempts, last_error
  FROM outbox_messages
 WHERE failed_at IS NOT NULL
 ORDER BY updated_at DESC LIMIT 20;
```

1. Is the worker running? `docker compose ps worker`
2. Is Redis reachable? The dispatcher cannot enqueue without it.
3. `last_error` on failed rows usually names the problem directly.
4. To retry rows that were given up on, after fixing the cause:

```sql
UPDATE outbox_messages
   SET failed_at = NULL, attempts = 0, available_at = now()
 WHERE failed_at IS NOT NULL AND event_type = '<the one you fixed>';
```

Be specific about which rows. Resetting everything will re-send anything that
failed for a good reason.

---

## Dead-letter queue

**Alert:** `DeadLetterQueueGrowing`

Jobs that exhausted their retries, or failed permanently, are recorded on
`<queue>-dlq`. Nothing retries out of it automatically — replay is an explicit
decision.

```sh
docker compose exec worker node -e "
const {Queue} = require('bullmq');
const q = new Queue('email-dlq', {connection:{url:process.env.REDIS_URL}, prefix: process.env.REDIS_KEY_PREFIX + ':q'});
q.getJobs(['waiting']).then(js => { js.slice(0,10).forEach(j => console.log(j.id, JSON.stringify(j.data.failure))); process.exit(0); });
"
```

Read the failure reasons before replaying anything. A permanent failure (a
rejected recipient) will fail again; a transient one (a provider outage) will
not.

---

## Login failure spike

**Alert:** `LoginFailureSpike`

Failed sign-ins far exceeding successful ones suggests credential stuffing.

```sql
SELECT ip_address, count(*)
  FROM audit_logs
 WHERE action = 'auth.login.failed'
   AND created_at > now() - interval '1 hour'
 GROUP BY ip_address ORDER BY count DESC LIMIT 20;
```

IPs are stored truncated to /24, which is enough to spot a source and to block
one at Cloudflare.

Per-account lockout and per-source throttling are already applied. If it is
distributed and sustained, tighten `RATE_LIMIT_AUTH_PER_MINUTE`, add a
Cloudflare rule, and check whether any account actually succeeded — that is the
one that matters.

---

## Restore drill

Run quarterly. Put the date in the calendar; a backup that has never been
restored is a hypothesis.

```sh
# 1. Restore the most recent backup into a scratch database
./scripts/restore.sh health-commerce-scheduled-<stamp> drill_$(date +%Y%m%d)

# 2. Check it is real
docker compose exec postgres psql -U "$POSTGRES_USER" -d drill_$(date +%Y%m%d) -c "
  SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'roles', count(*) FROM roles
  UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
  UNION ALL SELECT 'customers', count(*) FROM customers;"

# 3. Verify the append-only triggers survived the restore
docker compose exec postgres psql -U "$POSTGRES_USER" -d drill_$(date +%Y%m%d) -c "
  SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal;"

# 4. Drop the scratch database
docker compose exec postgres dropdb -U "$POSTGRES_USER" drill_$(date +%Y%m%d)
```

Record: how long the restore took, whether anything was missing, and what you
had to look up. That last one is the most valuable output of the drill.

---

## Suspected compromise

1. **Preserve evidence before changing anything.** Snapshot logs and the audit
   table; you cannot get them back afterwards.
2. Rotate `SESSION_SECRET` — every access token dies immediately.
3. Revoke all sessions:

```sql
UPDATE user_sessions
   SET revoked_at = now(), revoked_reason = 'ADMIN_REVOKED'
 WHERE revoked_at IS NULL;
```

4. Review recent privileged actions:

```sql
SELECT * FROM audit_logs
 WHERE action IN ('user.roles.changed','role.updated','role.created',
                  'system.setting.updated','mfa.disabled','user.invited')
   AND created_at > now() - interval '7 days'
 ORDER BY created_at DESC;
```

5. Rotate database, Redis and provider credentials.
6. Force password resets for affected accounts.
7. If customer data may have been accessed, involve counsel immediately —
   breach-notification obligations are time-bound and vary by state.

The audit log cannot be altered by the application, so it remains trustworthy
even if the application itself was compromised. That is the whole reason for the
database-level trigger.
