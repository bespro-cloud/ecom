import { createHarness, STRONG_PASSWORD, type TestHarness } from './harness.js';

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

describe('health endpoints', () => {
  it('reports liveness without touching a dependency', async () => {
    const response = await harness.http().get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('reports readiness with dependency detail', async () => {
    const response = await harness.http().get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.dependencies.database.status).toBe('up');
    expect(response.body.dependencies.redis.status).toBe('up');
  });

  it('is reachable without a version prefix or authentication', async () => {
    // Probes must not have to track API versions or hold credentials.
    expect((await harness.http().get('/health')).status).toBe(200);
    expect((await harness.http().get('/api/v1/health')).status).toBe(404);
  });

  it('exposes Prometheus metrics', async () => {
    await harness.http().get('/health/live');
    const response = await harness.http().get('/health/metrics');
    expect(response.status).toBe(200);
    expect(response.text).toContain('http_requests_total');
    expect(response.text).toContain('service="api"');
  });
});

describe('error handling', () => {
  it('returns a stable shape with a correlation id for every error', async () => {
    const response = await harness.http().get('/api/v1/auth/me');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: expect.any(String),
        correlationId: expect.any(String),
      },
    });
    expect(response.headers['x-correlation-id']).toBe(response.body.error.correlationId);
  });

  it('echoes a caller-supplied correlation id when it is a valid UUID', async () => {
    const supplied = '11111111-2222-4333-8444-555555555555';
    const response = await harness.http().get('/api/v1/auth/me').set('X-Correlation-Id', supplied);
    expect(response.body.error.correlationId).toBe(supplied);
  });

  it('ignores a malformed correlation id rather than putting it in logs', async () => {
    const response = await harness
      .http()
      .get('/api/v1/auth/me')
      // A header value that is well-formed HTTP but is not a UUID; the
      // middleware must not adopt it as the correlation id.
      .set('X-Correlation-Id', '../../etc/passwd or an injected log line');
    expect(response.body.error.correlationId).not.toContain('injected');
    expect(response.body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never leaks internal detail on an unhandled failure', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'not an email', password: '' });

    expect(response.status).toBe(400);
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/at .*\.ts:/);
    expect(body).not.toContain('prisma');
    expect(body).not.toContain('SELECT');
  });

  it('rejects an oversized payload', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'a@b.test', password: 'x'.repeat(2 * 1024 * 1024) });
    expect(response.status).toBe(413);
  });

  it('returns 404 for an unknown route', async () => {
    const response = await harness.http().get('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('security headers', () => {
  it('sets the expected hardening headers', async () => {
    const response = await harness.http().get('/health/live');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // Server fingerprinting.
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('throttles repeated sign-in attempts and reports the window', async () => {
    const attempt = () =>
      harness
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.test', password: 'wrong' });

    let limited: Awaited<ReturnType<typeof attempt>> | null = null;
    // The test env allows 1000/min, so drive the counter directly to keep the
    // test fast while still exercising the guard's response path.
    await harness.redis.client.set(
      harness.redis.key('ratelimit:auth:POST:/api/v1/auth/login', 'ip:127.0.0.0'),
      '99999',
      'EX',
      60,
    );
    limited = await attempt();

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('60');
  });

  it('exempts health probes', async () => {
    for (let i = 0; i < 30; i += 1) {
      const response = await harness.http().get('/health/live');
      expect(response.status).toBe(200);
    }
  });

  it('advertises the remaining budget', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'wrong' });
    expect(Number(response.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    expect(response.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('transactional outbox', () => {
  it('writes the event and the state change atomically', async () => {
    await harness.http().post('/api/v1/auth/register').send({
      email: 'outbox@example.test',
      password: STRONG_PASSWORD,
      firstName: 'Out',
      lastName: 'Box',
      acceptsTerms: true,
    });

    const [user, messages] = await Promise.all([
      harness.prisma.user.findFirstOrThrow({ where: { emailNormalized: 'outbox@example.test' } }),
      harness.prisma.outboxMessage.findMany(),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.aggregateId).toBe(user.id);
    expect(messages[0]!.dispatchedAt).toBeNull();
    expect(messages[0]!.attempts).toBe(0);
    // The verification token travels in the event, never in the response.
    expect(messages[0]!.payload).toHaveProperty('verificationToken');
  });
});
