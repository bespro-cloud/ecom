import { AccessTokenService } from '@health/auth';
import { SYSTEM_ROLES } from '@health/types';
import {
  createHarness,
  signedInCustomer,
  signedInStaff,
  STRONG_PASSWORD,
  type SignedInCustomer,
  type SignedInStaff,
  type TestHarness,
} from './harness.js';

/**
 * The checks a penetration test would run, as regression tests.
 *
 * **This is not a penetration test and does not stand in for one.** A tester
 * brings intent, chains weaknesses nobody wrote a test for, and looks at the
 * parts of the system its author did not think were interesting. What this file
 * does is stop the findings you already know about from coming back — it is a
 * floor, not a ceiling, and the known-gaps section of SECURITY.md says so.
 *
 * Everything here attacks the running application over HTTP with the same
 * middleware, guards and database a deployment uses. Nothing is mocked, because
 * the layers being tested are exactly the ones a mock would remove.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

const bearer = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });

/** Reads a JWT payload without verifying it — for building forgeries. */
function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** Every permission in the catalogue, which is what an escalation would want. */
function everyPermission(): string[] {
  const superAdmin = SYSTEM_ROLES.find((role) => role.key === 'SUPER_ADMIN');
  return [...(superAdmin?.permissions ?? [])];
}

async function seedOrderFor(customerId: string | null): Promise<string> {
  const order = await harness.prisma.order.create({
    data: {
      reference: `HC-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      customerId,
      email: 'holder@example.test',
      subtotalCents: 2400,
      totalCents: 2400,
      shippingAddress: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        line1: '12 Analytical Way',
        city: 'Salt Lake City',
        region: 'UT',
        postalCode: '84101',
        country: 'US',
      },
    },
  });
  return order.id;
}

// ---------------------------------------------------------------------------
// Authentication: what a stolen, forged or stale token can do
// ---------------------------------------------------------------------------

describe('token forgery', () => {
  it('refuses a token signed with a different key, however good its claims look', async () => {
    const customer = await signedInCustomer(harness);
    const claims = payloadOf(customer.token);

    // The attacker's own signing key. Everything else — subject, session id,
    // issuer, audience — is copied from a genuine token, so the signature is
    // the only thing standing between a customer and every permission there is.
    const forger = new AccessTokenService(
      Buffer.from('an-attackers-own-signing-key-32b').toString('base64'),
    );
    const forged = await forger.signAccessToken(
      {
        sub: claims.sub as string,
        sid: claims.sid as string,
        email: customer.email,
        type: 'STAFF',
        roles: ['SUPER_ADMIN'],
        permissions: everyPermission() as never,
        mfa: true,
      },
      { issuedAt: new Date(), ttlSeconds: 900 },
    );

    const response = await harness
      .http()
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('refuses an unsigned token that claims alg: none', async () => {
    const customer = await signedInCustomer(harness);
    const claims = { ...payloadOf(customer.token), permissions: everyPermission() };
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;

    const response = await harness
      .http()
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${unsigned}`);

    expect(response.status).toBe(401);
  });

  it('refuses a validly signed token whose session belongs to someone else', async () => {
    // The signing key is not the only check: the session row must belong to the
    // subject. Without this, one compromised session id would authenticate any
    // account an attacker could name.
    const victim = await signedInCustomer(harness, 'victim@example.test');
    const attacker = await signedInCustomer(harness, 'attacker@example.test');

    const tokens = harness.app.get(AccessTokenService);
    const stitched = await tokens.signAccessToken(
      {
        sub: victim.userId,
        sid: payloadOf(attacker.token).sid as string,
        email: victim.email,
        type: 'CUSTOMER',
        roles: ['CUSTOMER'],
        permissions: [],
        mfa: false,
      },
      { issuedAt: new Date(), ttlSeconds: 900 },
    );

    const response = await harness
      .http()
      .get('/api/v1/me/profile')
      .set('Authorization', `Bearer ${stitched}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('SESSION_REVOKED');
  });

  it('will not let a validly signed token claim an MFA the session never satisfied', async () => {
    // Issued with the application's own key, so the signature proves nothing
    // here: the question is not "is this token genuine" but "did this person
    // actually present a second factor". The session row is the authority.
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const claims = payloadOf(reviewer.token);

    await harness.prisma.userSession.update({
      where: { id: claims.sid as string },
      data: { mfaSatisfied: false },
    });

    const tokens = harness.app.get(AccessTokenService);
    const lying = await tokens.signAccessToken(
      {
        sub: claims.sub as string,
        sid: claims.sid as string,
        email: reviewer.email,
        type: 'STAFF',
        roles: claims.roles as string[],
        permissions: claims.permissions as never,
        mfa: true,
      },
      { issuedAt: new Date(), ttlSeconds: 900 },
    );

    const response = await harness
      .http()
      .get('/api/v1/admin/compliance/claims')
      .set('Authorization', `Bearer ${lying}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('MFA_REQUIRED');
  });

  it('stops accepting a token the moment its session is signed out', async () => {
    const customer = await signedInCustomer(harness);

    expect((await harness.http().get('/api/v1/me/profile').set(bearer(customer))).status).toBe(200);

    await harness.http().post('/api/v1/auth/logout').set(bearer(customer));

    const after = await harness.http().get('/api/v1/me/profile').set(bearer(customer));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('treats a garbage bearer value as unauthenticated rather than failing', async () => {
    for (const value of ['Bearer', 'Bearer ', 'Bearer not.a.jwt', 'Bearer ...', 'Basic YWRtaW4=']) {
      const response = await harness.http().get('/api/v1/me/profile').set('Authorization', value);
      expect(response.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Authorisation: reaching someone else's data
// ---------------------------------------------------------------------------

describe('object ownership', () => {
  let alice: SignedInCustomer;
  let mallory: SignedInCustomer;

  beforeEach(async () => {
    alice = await signedInCustomer(harness, 'alice@example.test');
    mallory = await signedInCustomer(harness, 'mallory@example.test');
  });

  it("answers 404, not 403, for another customer's order", async () => {
    const orderId = await seedOrderFor(alice.customerId);

    const mine = await harness.http().get(`/api/v1/orders/${orderId}`).set(bearer(alice));
    expect(mine.status).toBe(200);

    const theirs = await harness.http().get(`/api/v1/orders/${orderId}`).set(bearer(mallory));
    // 403 would confirm the id exists. A miss and a refusal must be
    // indistinguishable, or the endpoint becomes an oracle for enumerating
    // order ids.
    expect(theirs.status).toBe(404);
    expect(theirs.body.error.code).toBe('NOT_FOUND');
  });

  it('will not hand a guest order to a browser holding no cart cookie', async () => {
    const orderId = await seedOrderFor(null);
    const response = await harness.http().get(`/api/v1/orders/${orderId}`);
    expect(response.status).toBe(404);
  });

  it("refuses to update or delete another customer's address", async () => {
    const address = await harness.prisma.customerAddress.create({
      data: {
        customerId: alice.customerId,
        firstName: 'Ada',
        lastName: 'Lovelace',
        line1: '12 Analytical Way',
        city: 'Salt Lake City',
        region: 'UT',
        postalCode: '84101',
      },
    });

    const patched = await harness
      .http()
      .patch(`/api/v1/me/addresses/${address.id}`)
      .set(bearer(mallory))
      .send({ line1: '1 Attacker Way' });
    expect(patched.status).toBe(404);

    const deleted = await harness
      .http()
      .delete(`/api/v1/me/addresses/${address.id}`)
      .set(bearer(mallory));
    expect(deleted.status).toBe(404);

    const unchanged = await harness.prisma.customerAddress.findUniqueOrThrow({
      where: { id: address.id },
    });
    expect(unchanged.line1).toBe('12 Analytical Way');
    expect(unchanged.deletedAt).toBeNull();
  });

  it('keeps a customer out of every staff surface', async () => {
    const staffOnly = [
      '/api/v1/users',
      '/api/v1/roles',
      '/api/v1/audit-logs',
      '/api/v1/admin/catalogue/products',
      '/api/v1/admin/commerce/orders',
      '/api/v1/admin/compliance/claims',
      '/api/v1/admin/ai/suggestions',
      '/api/v1/admin/growth/redirects',
      '/api/v1/system/settings',
    ];

    for (const path of staffOnly) {
      const response = await harness.http().get(path).set(bearer(alice));
      expect([403, 404]).toContain(response.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Privilege escalation
// ---------------------------------------------------------------------------

describe('privilege escalation', () => {
  it('refuses a request that tries to set its own account type or roles', async () => {
    const customer = await signedInCustomer(harness);

    const response = await harness
      .http()
      .patch('/api/v1/me/profile')
      .set(bearer(customer))
      .send({ firstName: 'Ada', type: 'STAFF', status: 'ACTIVE', roles: ['SUPER_ADMIN'] });

    // Refused outright rather than silently ignored: an endpoint that accepts a
    // field it does not honour teaches callers that it might one day.
    expect(response.status).toBe(400);

    const user = await harness.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.type).toBe('CUSTOMER');
  });

  it('will not let a staff member who may only read roles change what one can do', async () => {
    // ANALYST holds ROLE_READ and not ROLE_MANAGE — read and write on the same
    // resource are separate permissions precisely so this request fails.
    const analyst = await signedInStaff(harness, 'ANALYST');
    const role = await harness.prisma.role.findUniqueOrThrow({ where: { key: 'SUPPORT_AGENT' } });

    const listed = await harness.http().get('/api/v1/roles').set(bearer(analyst));
    expect(listed.status).toBe(200);

    const response = await harness
      .http()
      .put(`/api/v1/roles/${role.id}`)
      .set(bearer(analyst))
      .send({ permissions: everyPermission() });

    expect(response.status).toBe(403);
  });

  it('does not tell the caller which permission they were missing', async () => {
    const analyst = await signedInStaff(harness, 'ANALYST');
    const response = await harness.http().get('/api/v1/users').set(bearer(analyst));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    // The guard records the missing permission as internal detail for the log.
    // Returning it would hand an attacker a map of which account to phish.
    expect(JSON.stringify(response.body)).not.toContain('USER_READ');
    expect(JSON.stringify(response.body)).not.toContain('missing permissions');
  });

  it('keeps staff out of customer self-service routes', async () => {
    const admin = await signedInStaff(harness, 'ADMIN');
    const response = await harness.http().get('/api/v1/me/profile').set(bearer(admin));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

describe('hostile input', () => {
  it('treats SQL as data everywhere it is accepted', async () => {
    const injections = [
      "'; DROP TABLE products; --",
      "' OR '1'='1",
      '1; SELECT pg_sleep(10)--',
      "\\'; DELETE FROM users WHERE 't'='t",
    ];

    for (const value of injections) {
      const search = await harness.http().get('/api/v1/catalogue/products').query({ q: value });
      expect([200, 400]).toContain(search.status);
    }

    // The tables an injection would have gone for are still there. Prisma
    // parameterises, but the assertion is what makes that a tested property
    // rather than a belief about the ORM.
    const tables = await harness.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('products', 'users')`,
    );
    expect(Number(tables[0].count)).toBe(2);
  });

  it('refuses a body carrying fields the endpoint does not define', async () => {
    const customer = await signedInCustomer(harness);
    const response = await harness
      .http()
      .patch('/api/v1/me/profile')
      .set(bearer(customer))
      .send({ firstName: 'Ada', isAdmin: true });
    expect(response.status).toBe(400);
  });

  it('does not let a request body pollute Object.prototype', async () => {
    const customer = await signedInCustomer(harness);
    await harness
      .http()
      .patch('/api/v1/me/profile')
      .set(bearer(customer))
      .set('Content-Type', 'application/json')
      .send('{"firstName":"Ada","__proto__":{"polluted":"yes"},"constructor":{"x":1}}');

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not resolve traversal sequences in a path parameter', async () => {
    for (const slug of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', '....//....//etc/passwd']) {
      const response = await harness
        .http()
        .get(`/api/v1/catalogue/products/${encodeURIComponent(slug)}`);
      expect([400, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain('root:');
    }
  });

  it('answers with JSON a browser will not execute, whatever is stored', async () => {
    const customer = await signedInCustomer(harness);
    const payload = '<script>alert(document.cookie)</script>';

    const saved = await harness
      .http()
      .patch('/api/v1/me/profile')
      .set(bearer(customer))
      .send({ firstName: payload });

    // Whether the field is rejected by validation or stored verbatim is the
    // endpoint's business. What matters is that the response is JSON and
    // declared non-sniffable — the browser is never asked to parse this as a
    // document.
    expect(saved.headers['content-type']).toMatch(/application\/json/);
    expect(saved.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects a quantity supplied as something other than a positive integer', async () => {
    const customer = await signedInCustomer(harness);
    for (const quantity of ['1', -1, 0, 1.5, Number.MAX_SAFE_INTEGER, null, [], {}]) {
      const response = await harness
        .http()
        .post('/api/v1/cart/items')
        .set(bearer(customer))
        .send({ variantId: '00000000-0000-4000-8000-000000000000', quantity });
      expect([400, 404, 422]).toContain(response.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Session transport
// ---------------------------------------------------------------------------

describe('session transport', () => {
  it('issues auth cookies that JavaScript cannot read and a CSRF cookie it can', async () => {
    const email = 'cookie-check@example.test';
    await signedInCustomer(harness, email);

    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email, password: STRONG_PASSWORD });

    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const find = (name: string) => cookies.find((cookie) => cookie.startsWith(`${name}=`)) ?? '';

    expect(find('hc_access')).toMatch(/HttpOnly/i);
    expect(find('hc_access')).toMatch(/SameSite=Lax/i);
    expect(find('hc_refresh')).toMatch(/HttpOnly/i);
    // Scoped so it is not attached to ordinary API calls at all.
    expect(find('hc_refresh')).toMatch(/Path=\/api\/v1\/auth/);
    // Readable on purpose — the browser has to echo it back in a header.
    expect(find('hc_csrf')).not.toMatch(/HttpOnly/i);
  });

  it('refuses a cookie-authenticated write with no CSRF header', async () => {
    const email = 'csrf-check@example.test';
    await signedInCustomer(harness, email);

    const agent = harness.http();
    await agent.post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD });

    // The agent now carries the cookies a browser would send from a forged
    // form, and nothing else.
    const forged = await agent.patch('/api/v1/me/profile').send({ firstName: 'Mallory' });
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('does not grant an unlisted origin a CORS allowance', async () => {
    const response = await harness
      .http()
      .get('/api/v1/catalogue/products')
      .set('Origin', 'https://not-our-site.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('clears the auth cookies on sign-out', async () => {
    const customer = await signedInCustomer(harness, 'signout-check@example.test');

    const response = await harness.http().post('/api/v1/auth/logout').set(bearer(customer));
    const cookies = (response.headers['set-cookie'] as unknown as string[]) ?? [];
    const cleared = cookies.filter((cookie) => /^(hc_access|hc_refresh|hc_csrf)=;/.test(cookie));
    expect(cleared.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Information disclosure
// ---------------------------------------------------------------------------

describe('what the API tells an attacker', () => {
  it('answers identically whether or not the email exists', async () => {
    const email = 'known@example.test';
    await signedInCustomer(harness, email);

    const known = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email, password: 'definitely the wrong password' });
    const unknown = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody-at-all@example.test', password: 'definitely the wrong password' });

    expect(known.status).toBe(unknown.status);
    expect(known.body.error.code).toBe(unknown.body.error.code);
    expect(known.body.error.message).toBe(unknown.body.error.message);
  });

  it('never returns password material in any user-shaped response', async () => {
    const admin = await signedInStaff(harness, 'SUPER_ADMIN');
    const customer = await signedInCustomer(harness);

    const responses = [
      await harness.http().get('/api/v1/users').set(bearer(admin)),
      await harness.http().get('/api/v1/auth/me').set(bearer(customer)),
      await harness.http().get('/api/v1/me/profile').set(bearer(customer)),
    ];

    for (const response of responses) {
      const body = JSON.stringify(response.body);
      for (const forbidden of [
        'passwordHash',
        'password_hash',
        'passwordAlgorithm',
        'totpSecret',
        'secretEncrypted',
        'argon2',
      ]) {
        expect(body).not.toContain(forbidden);
      }
    }
  });

  it('does not reveal infrastructure in the readiness probe', async () => {
    const response = await harness.http().get('/health/ready');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('redis://');
    expect(body).not.toMatch(/password/i);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting as a control, not a courtesy
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('buckets authenticated callers separately so one cannot exhaust another', async () => {
    const noisy = await signedInCustomer(harness, 'noisy@example.test');
    const quiet = await signedInCustomer(harness, 'quiet@example.test');

    await harness.redis.client.set(
      harness.redis.key('ratelimit:default:GET:/api/v1/me/profile', `user:${noisy.userId}`),
      '99999',
      'EX',
      60,
    );

    expect((await harness.http().get('/api/v1/me/profile').set(bearer(noisy))).status).toBe(429);
    expect((await harness.http().get('/api/v1/me/profile').set(bearer(quiet))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The separations that exist for compliance reasons
// ---------------------------------------------------------------------------

describe('separation of duty holds over HTTP', () => {
  it('does not let an administrator approve a health claim', async () => {
    const admin: SignedInStaff = await signedInStaff(harness, 'ADMIN');
    const held = SYSTEM_ROLES.find((role) => role.key === 'ADMIN')?.permissions ?? [];

    // Stated as a property of the catalogue and then proved over the wire, so
    // that a future role edit has to break a test rather than a convention.
    expect(held).not.toContain('CLAIM_APPROVE');
    expect(held).not.toContain('COMPLIANCE_APPROVE');

    const response = await harness
      .http()
      .post('/api/v1/admin/compliance/claims/00000000-0000-4000-8000-000000000000/decision')
      .set(bearer(admin))
      .send({ decision: 'APPROVED', reasoning: 'looks fine to me' });

    expect([403, 404]).toContain(response.status);
  });
});
