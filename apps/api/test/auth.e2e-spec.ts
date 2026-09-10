import { hashPassword, PASSWORD_ALGORITHM_ID } from '@health/auth';
import { createHarness, nextTotpCode, STRONG_PASSWORD, type TestHarness } from './harness.js';

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

const registration = {
  email: 'ada@example.test',
  password: STRONG_PASSWORD,
  firstName: 'Ada',
  lastName: 'Lovelace',
  acceptsTerms: true,
};

async function registerCustomer(overrides: Partial<typeof registration> = {}) {
  const response = await harness
    .http()
    .post('/api/v1/auth/register')
    .send({ ...registration, ...overrides });
  return response;
}

describe('POST /auth/register', () => {
  it('creates the user, customer, consent ledger and session in one go', async () => {
    const response = await registerCustomer();

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('ada@example.test');
    expect(response.body.user.roles).toEqual(['CUSTOMER']);
    expect(response.body.user.permissions).toEqual([]);
    expect(response.body.accessToken).toEqual(expect.any(String));

    const customer = await harness.prisma.customer.findFirst({
      where: { user: { emailNormalized: 'ada@example.test' } },
      include: { consents: true },
    });
    expect(customer).not.toBeNull();
    expect(customer!.reference).toMatch(/^HC-\d{6}$/);
    expect(customer!.consents.map((c) => c.type).sort()).toEqual([
      'MARKETING_EMAIL',
      'TERMS_OF_SERVICE',
    ]);
    // Marketing consent defaults to withheld: opt-in, never opt-out.
    expect(customer!.consents.find((c) => c.type === 'MARKETING_EMAIL')!.granted).toBe(false);
  });

  it('sets httpOnly auth cookies and a readable CSRF cookie', async () => {
    const response = await registerCustomer();
    const cookies = (response.headers['set-cookie'] as unknown as string[]) ?? [];

    const access = cookies.find((c) => c.startsWith('hc_access='))!;
    const refresh = cookies.find((c) => c.startsWith('hc_refresh='))!;
    const csrf = cookies.find((c) => c.startsWith('hc_csrf='))!;

    expect(access).toContain('HttpOnly');
    expect(access).toContain('SameSite=Lax');
    expect(refresh).toContain('HttpOnly');
    // Scoped so the refresh token is not attached to ordinary API calls.
    expect(refresh).toContain('Path=/api/v1/auth');
    expect(csrf).not.toContain('HttpOnly');
  });

  it('queues a welcome event in the same transaction', async () => {
    await registerCustomer();
    const outbox = await harness.prisma.outboxMessage.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('user.registered.v1');
    expect(outbox[0]!.dispatchedAt).toBeNull();
  });

  it('never stores the password in a recoverable form', async () => {
    await registerCustomer();
    const user = await harness.prisma.user.findFirstOrThrow({
      where: { emailNormalized: 'ada@example.test' },
    });
    expect(user.passwordHash).not.toContain(STRONG_PASSWORD);
    expect(user.passwordHash!.startsWith('$argon2id$')).toBe(true);
    expect(user.passwordAlgorithm).toBe(PASSWORD_ALGORITHM_ID);
  });

  it('rejects a weak password with field-level detail', async () => {
    const response = await registerCustomer({ password: 'password1234' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details[0].path).toBe('password');
  });

  it('requires terms acceptance', async () => {
    const response = await registerCustomer({ acceptsTerms: false as never });
    expect(response.status).toBe(400);
  });

  it('treats email as case-insensitive and does not confirm the address is taken', async () => {
    await registerCustomer();
    const response = await registerCustomer({ email: 'ADA@Example.test' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ALREADY_EXISTS');
    // The message must not confirm that this specific address is registered.
    expect(response.body.error.message).not.toMatch(/already (registered|exists)/i);
    expect(await harness.prisma.user.count()).toBe(1);
  });

  it('rolls the whole registration back if any step fails', async () => {
    // No CUSTOMER role => the transaction cannot complete.
    await harness.prisma.userRole.deleteMany({});
    await harness.prisma.role.delete({ where: { key: 'CUSTOMER' } });

    const response = await registerCustomer({ email: 'rollback@example.test' });
    expect(response.status).toBe(500);
    expect(await harness.prisma.user.count()).toBe(0);
    expect(await harness.prisma.customer.count()).toBe(0);
    expect(await harness.prisma.outboxMessage.count()).toBe(0);

    // Restore reference data for subsequent tests in this file.
    await harness.prisma.role.create({
      data: { key: 'CUSTOMER', name: 'Customer', isSystem: true, requiresMfa: false },
    });
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await registerCustomer();
  });

  it('signs in with correct credentials', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('ada@example.test');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrongPassword = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: 'definitely not the password' });
    const unknownAccount = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'definitely not the password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownAccount.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
  });

  it('records failed attempts and locks the account at the threshold', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await harness
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.test', password: `wrong-${attempt}` });
    }

    const locked = await harness.prisma.user.findFirstOrThrow({
      where: { emailNormalized: 'ada@example.test' },
    });
    expect(locked.failedLoginCount).toBeGreaterThanOrEqual(8);
    expect(locked.lockedUntil).not.toBeNull();

    // Even the correct password is refused while the lock holds.
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('clears the failure counter after a successful sign-in', async () => {
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: 'wrong' });
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });

    const user = await harness.prisma.user.findFirstOrThrow({
      where: { emailNormalized: 'ada@example.test' },
    });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lastLoginAt).not.toBeNull();
    // The stored IP is truncated, never the full address.
    expect(user.lastLoginIp === null || user.lastLoginIp.endsWith('.0')).toBe(true);
  });

  it('refuses a suspended account', async () => {
    await harness.prisma.user.updateMany({
      where: { emailNormalized: 'ada@example.test' },
      data: { status: 'SUSPENDED' },
    });

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('writes an audit record for both success and failure', async () => {
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: 'wrong' });
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });

    const actions = (await harness.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (log) => log.action,
    );
    expect(actions).toContain('auth.login.failed');
    expect(actions).toContain('auth.login.succeeded');
  });

  it('masks the email address in audit records', async () => {
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });

    const log = await harness.prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login.succeeded' },
    });
    expect(log.actorLabel).toBe('ada@example.test');
    expect(log.ipAddress === null || log.ipAddress.endsWith('.0')).toBe(true);
  });
});

describe('session lifecycle', () => {
  it('rotates the refresh token and revokes the family on replay', async () => {
    const agent = harness.http();
    const registered = await agent.post('/api/v1/auth/register').send(registration);

    const csrf = csrfFrom(registered);
    const first = await agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', csrf);
    expect(first.status).toBe(200);

    const stolen = await harness.prisma.userSession.findFirstOrThrow({
      where: { revokedReason: 'ROTATED' },
    });
    expect(stolen.rotatedToId).not.toBeNull();

    // Replaying the consumed token must burn the whole family.
    const replay = await harness
      .http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'not-the-real-token' });
    expect(replay.status).toBe(401);

    const second = await agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', csrf);
    expect(second.status).toBe(200);
  });

  it('revokes every session on logout-all', async () => {
    const agent = harness.http();
    const registered = await agent.post('/api/v1/auth/register').send(registration);
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });

    const csrf = csrfFrom(registered);
    const response = await agent.post('/api/v1/auth/logout-all').set('X-CSRF-Token', csrf);

    expect(response.status).toBe(200);
    expect(response.body.revokedSessions).toBeGreaterThanOrEqual(2);
    const live = await harness.prisma.userSession.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('stops accepting the access token once the session is revoked', async () => {
    const login = await registerCustomer();
    const token = login.body.accessToken as string;

    const before = await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    // Revocation must take effect at once, not when the JWT expires.
    await harness.prisma.userSession.updateMany({
      data: { revokedAt: new Date(), revokedReason: 'ADMIN_REVOKED' },
    });

    const after = await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('requires a CSRF header for cookie-authenticated writes', async () => {
    const agent = harness.http();
    const registered = await agent.post('/api/v1/auth/register').send(registration);

    const without = await agent.post('/api/v1/auth/logout');
    expect(without.status).toBe(403);
    expect(without.body.error.code).toBe('CSRF_TOKEN_INVALID');

    const csrf = csrfFrom(registered);
    const withHeader = await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf);
    expect(withHeader.status).toBe(204);
  });

  it('does not require CSRF for bearer-authenticated writes', async () => {
    const login = await registerCustomer();
    const response = await harness
      .http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(response.status).toBe(204);
  });
});

describe('password change and reset', () => {
  it('revokes other sessions but keeps the current one on password change', async () => {
    const login = await registerCustomer();
    const token = login.body.accessToken as string;
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: STRONG_PASSWORD });

    const response = await harness
      .http()
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: STRONG_PASSWORD, newPassword: 'another entirely fresh phrase' });

    expect(response.status).toBe(204);

    const stillValid = await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(stillValid.status).toBe(200);

    const revoked = await harness.prisma.userSession.count({
      where: { revokedReason: 'PASSWORD_CHANGED' },
    });
    expect(revoked).toBe(1);
  });

  it('refuses a password change with the wrong current password', async () => {
    const login = await registerCustomer();
    const response = await harness
      .http()
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: 'wrong', newPassword: 'another entirely fresh phrase' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses reusing the current password', async () => {
    const login = await registerCustomer();
    const response = await harness
      .http()
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: STRONG_PASSWORD, newPassword: STRONG_PASSWORD });

    expect(response.status).toBe(400);
  });

  it('answers identically whether or not the address exists', async () => {
    await registerCustomer();
    const known = await harness
      .http()
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'ada@example.test' });
    const unknown = await harness
      .http()
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'nobody@example.test' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });

  it('completes a reset, invalidates the token and revokes all sessions', async () => {
    await registerCustomer();
    await harness.http().post('/api/v1/auth/password/forgot').send({ email: 'ada@example.test' });

    const event = await harness.prisma.outboxMessage.findFirstOrThrow({
      where: { eventType: 'user.password_reset_requested.v1' },
    });
    const token = (event.payload as { token: string }).token;

    const reset = await harness
      .http()
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'a completely different phrase' });
    expect(reset.status).toBe(204);

    // Single use.
    const replay = await harness
      .http()
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'yet another different phrase' });
    expect(replay.status).toBe(401);

    const live = await harness.prisma.userSession.count({ where: { revokedAt: null } });
    expect(live).toBe(0);

    const signIn = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.test', password: 'a completely different phrase' });
    expect(signIn.status).toBe(200);
  });

  it('rejects an expired reset token', async () => {
    await registerCustomer();
    await harness.http().post('/api/v1/auth/password/forgot').send({ email: 'ada@example.test' });
    const event = await harness.prisma.outboxMessage.findFirstOrThrow({
      where: { eventType: 'user.password_reset_requested.v1' },
    });
    await harness.prisma.userToken.updateMany({
      where: { type: 'PASSWORD_RESET' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await harness
      .http()
      .post('/api/v1/auth/password/reset')
      .send({ token: (event.payload as { token: string }).token, password: 'a valid new phrase!' });
    expect(response.status).toBe(401);
  });
});

describe('multi-factor authentication', () => {
  async function createStaffUser(roleKey: string) {
    const role = await harness.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const user = await harness.prisma.user.create({
      data: {
        email: `${roleKey.toLowerCase()}@example.test`,
        emailNormalized: `${roleKey.toLowerCase()}@example.test`,
        passwordHash: await hashPassword(STRONG_PASSWORD),
        passwordAlgorithm: PASSWORD_ALGORITHM_ID,
        passwordUpdatedAt: new Date(),
        type: 'STAFF',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    return user;
  }

  async function signIn(email: string): Promise<string> {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email, password: STRONG_PASSWORD });
    return response.body.accessToken as string;
  }

  it('blocks privileged routes until a factor is enrolled, but allows enrolment', async () => {
    await createStaffUser('ADMIN');
    const token = await signIn('admin@example.test');

    const blocked = await harness
      .http()
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');

    const enroll = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`);
    expect(enroll.status).toBe(200);
    expect(enroll.body.uri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('completes enrolment, issues recovery codes and gates login behind a challenge', async () => {
    await createStaffUser('ADMIN');
    const token = await signIn('admin@example.test');

    const enroll = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`);

    const confirm = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ factorId: enroll.body.factorId, code: nextTotpCode(enroll.body.secret, 0) });

    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.test', password: STRONG_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('MFA_REQUIRED');
    expect(login.body.accessToken).toBeUndefined();

    const verified = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: login.body.challengeToken,
        code: nextTotpCode(enroll.body.secret, 1),
      });
    expect(verified.status).toBe(200);
    expect(verified.body.user.mfaEnabled).toBe(true);

    const allowed = await harness
      .http()
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${verified.body.accessToken}`);
    expect(allowed.status).toBe(200);
  });

  it('stores the TOTP secret encrypted and never returns it again', async () => {
    await createStaffUser('ADMIN');
    const token = await signIn('admin@example.test');
    const enroll = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`);

    const factor = await harness.prisma.userMfaFactor.findUniqueOrThrow({
      where: { id: enroll.body.factorId },
    });
    expect(factor.secretCiphertext).not.toContain(enroll.body.secret);
    expect(factor.secretCiphertext.startsWith('v1.')).toBe(true);

    const status = await harness
      .http()
      .get('/api/v1/auth/mfa')
      .set('Authorization', `Bearer ${token}`);
    expect(JSON.stringify(status.body)).not.toContain(enroll.body.secret);
  });

  it('rejects a replayed TOTP code', async () => {
    await createStaffUser('ADMIN');
    const token = await signIn('admin@example.test');
    const enroll = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`);
    const code = nextTotpCode(enroll.body.secret, 0);
    await harness
      .http()
      .post('/api/v1/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ factorId: enroll.body.factorId, code });

    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.test', password: STRONG_PASSWORD });

    // Same code, same time step: already spent.
    const replay = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('MFA_INVALID');
  });

  it('makes the challenge token single-use', async () => {
    await createStaffUser('ADMIN');
    const token = await signIn('admin@example.test');
    const enroll = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`);
    await harness
      .http()
      .post('/api/v1/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ factorId: enroll.body.factorId, code: nextTotpCode(enroll.body.secret, 0) });

    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.test', password: STRONG_PASSWORD });

    const wrong = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code: '000000' });
    expect(wrong.status).toBe(401);

    // Even with the right code, the challenge is spent.
    const retry = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: login.body.challengeToken,
        code: nextTotpCode(enroll.body.secret, 1),
      });
    expect(retry.status).toBe(401);
  });

  it('accepts a recovery code exactly once', async () => {
    await createStaffUser('ADMIN');
    const token = await signIn('admin@example.test');
    const enroll = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`);
    const confirm = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ factorId: enroll.body.factorId, code: nextTotpCode(enroll.body.secret, 0) });

    const recoveryCode = confirm.body.recoveryCodes[0] as string;

    const first = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.test', password: STRONG_PASSWORD });
    const used = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: first.body.challengeToken, recoveryCode });
    expect(used.status).toBe(200);

    const second = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.test', password: STRONG_PASSWORD });
    const reused = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: second.body.challengeToken, recoveryCode });
    expect(reused.status).toBe(401);
  });

  it('refuses to disable MFA for a role where it is mandatory', async () => {
    await createStaffUser('ADMIN');
    const token = await signIn('admin@example.test');
    const enroll = await harness
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`);
    await harness
      .http()
      .post('/api/v1/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ factorId: enroll.body.factorId, code: nextTotpCode(enroll.body.secret, 0) });

    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.test', password: STRONG_PASSWORD });
    const verified = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: login.body.challengeToken,
        code: nextTotpCode(enroll.body.secret, 1),
      });

    const response = await harness
      .http()
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${verified.body.accessToken}`)
      .send({ password: STRONG_PASSWORD, code: nextTotpCode(enroll.body.secret, 2) });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/mandatory/i);
  });

  it('refuses login once the enrolment grace period has passed', async () => {
    const user = await createStaffUser('COMPLIANCE_REVIEWER');
    await harness.prisma.user.update({
      where: { id: user.id },
      data: { passwordUpdatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'compliance_reviewer@example.test', password: STRONG_PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });
});

/**
 * Reads the double-submit CSRF value the server set on a response.
 *
 * The cookie is intentionally not httpOnly — a browser client reads it and
 * echoes it in a header — so taking it from `set-cookie` here mirrors exactly
 * what the front end does.
 */
function csrfFrom(response: { headers: Record<string, unknown> }): string {
  const cookies = (response.headers['set-cookie'] as unknown as string[]) ?? [];
  const csrf = cookies.find((cookie) => cookie.startsWith('hc_csrf='));
  if (!csrf) throw new Error('response did not set a CSRF cookie');
  return decodeURIComponent(csrf.split('=')[1]!.split(';')[0]!);
}
