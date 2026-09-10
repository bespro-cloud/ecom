# Security

## Scope

This describes the controls the platform implements and, just as importantly,
what they do not cover. Software controls are necessary; they are not the same
as being compliant, and nothing here should be read as a legal opinion.

## Authentication

### Passwords

- **Argon2id**, 19 MiB memory, 2 iterations, parallelism 1 — at or above the
  OWASP Password Storage baseline.
- The encoded hash embeds its parameters, so raising them later still verifies
  existing hashes. `needsRehash` reports hashes below current policy and they are
  upgraded silently on the next successful sign-in.
- Policy is length-first, per NIST SP 800-63B: minimum 12 characters, no forced
  composition rules, no forced rotation. Rejected: known breach-list entries
  (matched after undoing leetspeak and stripping padding, so `P@ssw0rd1234`
  fails), keyboard walks, repeated characters, and anything containing the user's
  own name or email.
- A sign-in attempt for an unknown address still runs a hash comparison, so
  response timing does not disclose whether an account exists.

### Sessions

Two tokens, with different jobs:

| Token   | Form                           | Lifetime | Revocable            |
| ------- | ------------------------------ | -------- | -------------------- |
| Access  | HS256 JWT                      | 15 min   | at the session check |
| Refresh | 256-bit opaque, SHA-256 stored | 30 days  | immediately          |

Refresh tokens rotate on every use. Presenting an already-consumed token has
only two explanations — theft or a badly-behaved client — so the entire session
family is revoked, which logs out both the attacker and the legitimate user and
forces re-authentication. This is standard OAuth 2.1 refresh-token rotation.

The access token is short-lived but not blindly trusted: the guard also confirms
the session row is still live, which is what makes logout, password change,
suspension and role changes take effect _immediately_ rather than at token
expiry.

### Multi-factor authentication

- TOTP (RFC 6238), ±1 step drift window.
- Shared secrets are encrypted at rest with AES-256-GCM, keyed by
  `ENCRYPTION_KEY` and bound to the owning user id as additional authenticated
  data — a ciphertext copied to another row will not decrypt.
- The accepted counter is persisted, so a valid code cannot be presented twice
  even inside its window.
- Enrolment is two-step: a factor stays `PENDING` until the user proves they can
  generate a code, so a half-finished setup cannot lock anyone out.
- Ten single-use recovery codes, hashed, shown exactly once. No endpoint returns
  them again.
- The password step alone never yields a session — it yields a single-use
  challenge token whose nonce is claimed atomically in Redis.
- Mandatory for `SUPER_ADMIN`, `ADMIN` and `COMPLIANCE_REVIEWER`. Those roles
  cannot turn it off, and disabling it elsewhere needs both the password and a
  current code, so a stolen session cannot strip the second factor.
- A privileged account that has not enrolled can reach _only_ the enrolment
  endpoints, and sign-in stops working entirely once the grace period
  (`security.staff_mfa_grace_period_days`) has passed.

### Brute-force resistance

Three independent layers, because any one of them can be worked around:

1. Per-account failure counter with temporary lockout (8 attempts, 15 minutes).
2. Per-source-address counter in Redis, so one address cannot grind through many
   accounts.
3. Route-level rate limiting on the auth tier.

## Authorisation

- Guards test **permissions**, never role names.
- Permissions are derived from roles at token issue, so revoking a permission
  from a role affects everyone without a back-fill.
- System roles are defined in code and reconciled on deploy. The API cannot edit
  them; the RBAC sync also _removes_ grants that have drifted, so a permission
  added directly in SQL is revoked on the next deploy.
- `ADMIN` cannot approve claims or compliance reviews. That separation is the
  point of having a review process.
- Changing a user's roles requires a written reason, cannot be done to your own
  account, and revokes the target's sessions immediately.
- The last active `SUPER_ADMIN` cannot be demoted.

## Session transport

Cookies, not `localStorage`:

| Cookie       | httpOnly | SameSite | Path           |
| ------------ | -------- | -------- | -------------- |
| `hc_access`  | yes      | Lax      | `/`            |
| `hc_refresh` | yes      | Lax      | `/api/v1/auth` |
| `hc_csrf`    | **no**   | Lax      | `/`            |

`Secure` is on everywhere except explicit local development, and the environment
contract refuses to boot production without it.

`hc_refresh` is path-scoped so it is not attached to ordinary API calls at all.
`hc_csrf` is readable by design — the browser must echo it in a header, and its
value is useless to anyone who cannot read the response.

XSS cannot read the tokens. The residual CSRF exposure is closed by `SameSite=Lax`
plus a double-submit token on every cookie-authenticated state-changing request.
Bearer-authenticated requests are exempt, since a cross-site form cannot set an
`Authorization` header.

## Input handling

- Every request body, query and parameter is validated with Zod at the boundary,
  and the **parsed** value replaces the raw input — unknown properties are
  stripped rather than passed through.
- Front-end validation uses the same schemas, for immediate feedback only. The
  API re-validates everything and is the sole authority.
- Prisma parameterises all queries. The one raw query in the codebase (the
  outbox `SKIP LOCKED` claim) has no interpolated user input.
- Pagination cursors are opaque and validated to be UUIDs; a forged cursor is
  ignored rather than reaching the query.

## Error handling

One shape for every error, with a correlation id and no internal detail:

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "…", "correlationId": "…" } }
```

Never returned: stack traces, SQL, Prisma error text, provider payloads,
internal hostnames. Database and dependency errors are logged in full and
surfaced as a generic 500 or 503.

## Logging and privacy

Redaction is configured at the transport, not at call sites, so it cannot be
forgotten:

- **Never logged**: passwords, hashes, access or refresh tokens, MFA codes and
  secrets, recovery codes, payment credentials, `Authorization` and `Cookie`
  headers.
- **Reduced before storage**: email addresses are masked (`a***@example.com`);
  phone numbers keep the last four digits; IPv4 is truncated to /24 and IPv6
  to /48.
- Query strings are stripped from access logs, because a mis-built client link
  can put a token in one.
- Health checks are excluded from request logging.

Audit `before`/`after` snapshots pass through the same deep redactor.

An inbound `X-Correlation-Id` is honoured only when it is a well-formed UUID, so
a client cannot inject text into log lines.

## Secrets

- Key material must decode to at least 32 bytes; the process refuses to start
  otherwise.
- Real secrets come from the environment, injected by a secret manager. `.env` is
  git-ignored and CI fails on a tracked one.
- `scripts/check-secrets.mjs` scans tracked files for credential patterns.
- No secret is ever a `NEXT_PUBLIC_*` value — those are compiled into the client
  bundle.

### Rotation

**`SESSION_SECRET`** — rotating invalidates every access token and MFA
challenge. Users are signed out; refresh tokens still work, so most sessions
recover on the next refresh. This is the right response to a suspected token
compromise.

**`ENCRYPTION_KEY`** — rotating **without re-encrypting** makes every enrolled
TOTP factor unusable and forces the whole staff to re-enrol from recovery codes.
The ciphertext envelope carries a version tag so a re-encryption migration can
tell old from new. Do not rotate this casually.

**Database and provider credentials** — rotate at the provider, update the
secret manager, redeploy. No code change.

## Transport and network

- TLS 1.2/1.3 only, modern ciphers, OCSP stapling.
- HSTS with `includeSubDomains` and `preload` in production.
- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy` on every response —
  including error responses, which is what `always` is for in the nginx config.
- CORS is an explicit allow-list; a wildcard is refused in production.
- The database, cache and object storage publish no ports in the production
  overlay. Only nginx is reachable.
- Cloudflare in front is defence in depth, never a substitute: anything that
  reaches the origin directly bypasses it entirely.

## Containers

Non-root user, `no-new-privileges`, all capabilities dropped, read-only root
filesystem with a small tmpfs, resource limits, multi-stage builds so no
toolchain reaches the runtime layer, and image scanning in CI.

## Known gaps

Stated plainly, because an unlisted gap is worse than a listed one.

1. **No breach-corpus lookup.** The block-list is a local heuristic. A
   k-anonymity check against Have I Been Pwned is planned once outbound network
   policy for it is agreed.
2. **No WebAuthn.** TOTP only. Hardware keys are materially stronger for
   privileged staff and are the next MFA increment.
3. **No penetration test.** Scheduled for Phase 8. Nothing here has been tested
   by an independent party.
4. **No load testing.** No throughput figure is claimed anywhere.
5. **No automated browser E2E.** Flows were verified manually against running
   services; Playwright lands in Phase 2.
6. **Audit retention is manual.** The application cannot delete audit rows at
   all — by design. Retention is a privileged, out-of-band operation
   (see [../operations/RETENTION.md](../operations/RETENTION.md)).

## Reporting a vulnerability

Do not open a public issue. Email the address in the repository's security
contact with reproduction steps and, if you have one, a suggested remediation.
Expect acknowledgement within two business days.
