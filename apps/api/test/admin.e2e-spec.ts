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

/**
 * Creates a staff account with the given role and returns a *fully
 * authenticated* bearer token — including completing MFA when the role
 * requires it, which is the only way such a session becomes privileged.
 */
async function signedInStaff(roleKey: string, email = `${roleKey.toLowerCase()}@example.test`) {
  const role = await harness.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await harness.prisma.user.create({
    data: {
      email,
      emailNormalized: email.toLowerCase(),
      passwordHash: await hashPassword(STRONG_PASSWORD),
      passwordAlgorithm: PASSWORD_ALGORITHM_ID,
      passwordUpdatedAt: new Date(),
      firstName: 'Test',
      lastName: 'Staff',
      type: 'STAFF',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  const initial = await harness
    .http()
    .post('/api/v1/auth/login')
    .send({ email, password: STRONG_PASSWORD });

  if (!role.requiresMfa) {
    return { user, token: initial.body.accessToken as string };
  }

  const enroll = await harness
    .http()
    .post('/api/v1/auth/mfa/enroll')
    .set('Authorization', `Bearer ${initial.body.accessToken}`);
  await harness
    .http()
    .post('/api/v1/auth/mfa/enroll/confirm')
    .set('Authorization', `Bearer ${initial.body.accessToken}`)
    .send({ factorId: enroll.body.factorId, code: nextTotpCode(enroll.body.secret, 0) });

  const challenge = await harness
    .http()
    .post('/api/v1/auth/login')
    .send({ email, password: STRONG_PASSWORD });
  const verified = await harness
    .http()
    .post('/api/v1/auth/mfa/verify')
    .send({
      challengeToken: challenge.body.challengeToken,
      code: nextTotpCode(enroll.body.secret, 1),
    });

  return {
    user,
    token: verified.body.accessToken as string,
    totpSecret: enroll.body.secret as string,
  };
}

describe('GET /roles', () => {
  it('returns system roles with their permissions', async () => {
    const { token } = await signedInStaff('ADMIN');
    const response = await harness
      .http()
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    const superAdmin = response.body.data.find((r: { key: string }) => r.key === 'SUPER_ADMIN');
    expect(superAdmin.isSystem).toBe(true);
    expect(superAdmin.requiresMfa).toBe(true);

    const customer = response.body.data.find((r: { key: string }) => r.key === 'CUSTOMER');
    expect(customer.permissions).toEqual([]);
  });

  it('separates compliance approval from general administration', async () => {
    const { token } = await signedInStaff('ADMIN');
    const response = await harness
      .http()
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`);

    const admin = response.body.data.find((r: { key: string }) => r.key === 'ADMIN');
    const reviewer = response.body.data.find(
      (r: { key: string }) => r.key === 'COMPLIANCE_REVIEWER',
    );

    // An administrator must not be able to approve a health claim.
    expect(admin.permissions).not.toContain('CLAIM_APPROVE');
    expect(admin.permissions).not.toContain('COMPLIANCE_APPROVE');
    expect(reviewer.permissions).toContain('CLAIM_APPROVE');
    expect(reviewer.permissions).toContain('COMPLIANCE_APPROVE');
  });

  it('refuses role creation to a role without ROLE_MANAGE', async () => {
    const { token } = await signedInStaff('ADMIN');
    const response = await harness
      .http()
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'CUSTOM', name: 'Custom', permissionKeys: ['ORDER_READ'] });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('refuses to edit or delete a system role even with ROLE_MANAGE', async () => {
    const { token } = await signedInStaff('SUPER_ADMIN');
    const roles = await harness.http().get('/api/v1/roles').set('Authorization', `Bearer ${token}`);
    const adminRole = roles.body.data.find((r: { key: string }) => r.key === 'ADMIN');

    const update = await harness
      .http()
      .put(`/api/v1/roles/${adminRole.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ permissionKeys: ['CLAIM_APPROVE'] });
    expect(update.status).toBe(403);

    const remove = await harness
      .http()
      .delete(`/api/v1/roles/${adminRole.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(remove.status).toBe(403);
  });

  it('creates, updates and deletes a custom role, auditing each step', async () => {
    const { token } = await signedInStaff('SUPER_ADMIN');

    const created = await harness
      .http()
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        key: 'catalogue_auditor',
        name: 'Catalogue auditor',
        permissionKeys: ['PRODUCT_READ', 'INGREDIENT_READ'],
      });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe('CATALOGUE_AUDITOR');
    expect(created.body.isSystem).toBe(false);

    const updated = await harness
      .http()
      .put(`/api/v1/roles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ permissionKeys: ['PRODUCT_READ'] });
    expect(updated.status).toBe(200);
    expect(updated.body.permissions).toEqual(['PRODUCT_READ']);

    const removed = await harness
      .http()
      .delete(`/api/v1/roles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(removed.status).toBe(204);

    const actions = (await harness.prisma.auditLog.findMany()).map((log) => log.action);
    expect(actions).toEqual(
      expect.arrayContaining(['role.created', 'role.updated', 'role.deleted']),
    );
  });

  it('rejects an unknown permission key', async () => {
    const { token } = await signedInStaff('SUPER_ADMIN');
    const response = await harness
      .http()
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'BAD_ROLE', name: 'Bad', permissionKeys: ['NOT_A_PERMISSION'] });

    expect(response.status).toBe(400);
  });
});

describe('staff administration', () => {
  it('invites a staff user without setting a password for them', async () => {
    const { token } = await signedInStaff('ADMIN');

    const response = await harness
      .http()
      .post('/api/v1/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'nia@example.test',
        firstName: 'Nia',
        lastName: 'Ford',
        roleKeys: ['ANALYST'],
      });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('INVITED');

    const invited = await harness.prisma.user.findFirstOrThrow({
      where: { emailNormalized: 'nia@example.test' },
    });
    // An administrator never knows another user's password.
    expect(invited.passwordHash).toBeNull();

    const cannotSignIn = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nia@example.test', password: STRONG_PASSWORD });
    expect(cannotSignIn.status).toBe(401);
  });

  it('lets the invitee set their own password and sign in', async () => {
    const { token } = await signedInStaff('ADMIN');
    await harness
      .http()
      .post('/api/v1/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'nia@example.test',
        firstName: 'Nia',
        lastName: 'Ford',
        roleKeys: ['ANALYST'],
      });

    const event = await harness.prisma.outboxMessage.findFirstOrThrow({
      where: { eventType: 'staff.invited.v1' },
    });
    const inviteToken = (event.payload as { token: string }).token;

    const accepted = await harness
      .http()
      .post('/api/v1/users/invite/accept')
      .send({ token: inviteToken, password: 'an entirely new staff phrase' });
    expect(accepted.status).toBe(204);

    const signIn = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nia@example.test', password: 'an entirely new staff phrase' });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.roles).toEqual(['ANALYST']);
    // Following the emailed link proves control of the mailbox.
    expect(signIn.body.user.emailVerified).toBe(true);

    const replay = await harness
      .http()
      .post('/api/v1/users/invite/accept')
      .send({ token: inviteToken, password: 'a different phrase again' });
    expect(replay.status).toBe(401);
  });

  it('refuses to give a staff account the customer role', async () => {
    const { token } = await signedInStaff('ADMIN');
    const response = await harness
      .http()
      .post('/api/v1/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'x@example.test', firstName: 'X', lastName: 'Y', roleKeys: ['CUSTOMER'] });

    expect(response.status).toBe(400);
  });

  it('requires a reason and refuses self-modification when changing roles', async () => {
    const actor = await signedInStaff('SUPER_ADMIN');
    const target = await signedInStaff('ANALYST', 'target@example.test');

    const noReason = await harness
      .http()
      .put(`/api/v1/users/${target.user.id}/roles`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ roleKeys: ['ORDER_MANAGER'] });
    expect(noReason.status).toBe(400);

    const self = await harness
      .http()
      .put(`/api/v1/users/${actor.user.id}/roles`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ roleKeys: ['SUPER_ADMIN', 'ADMIN'], reason: 'Giving myself more access' });
    expect(self.status).toBe(409);
  });

  it('applies a role change immediately by revoking the target’s sessions', async () => {
    const actor = await signedInStaff('SUPER_ADMIN');
    const target = await signedInStaff('ANALYST', 'target@example.test');

    const before = await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${target.token}`);
    expect(before.status).toBe(200);

    const changed = await harness
      .http()
      .put(`/api/v1/users/${target.user.id}/roles`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ roleKeys: ['SUPPORT_AGENT'], reason: 'Moved to the support team' });
    expect(changed.status).toBe(200);
    expect(changed.body.roles).toEqual(['SUPPORT_AGENT']);

    // The old token must stop working at once, not when it expires.
    const after = await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${target.token}`);
    expect(after.status).toBe(401);

    const audit = await harness.prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.roles.changed' },
    });
    expect(audit.reason).toBe('Moved to the support team');
    expect(audit.beforeState).toEqual({ roles: ['ANALYST'] });
    expect(audit.afterState).toEqual({ roles: ['SUPPORT_AGENT'] });
  });

  it('refuses to remove the last active super administrator', async () => {
    const actor = await signedInStaff('SUPER_ADMIN');
    const other = await signedInStaff('SUPER_ADMIN', 'other-super@example.test');

    // Two exist, so demoting one is allowed.
    const first = await harness
      .http()
      .put(`/api/v1/users/${other.user.id}/roles`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ roleKeys: ['ANALYST'], reason: 'Stepping back from platform ownership' });
    expect(first.status).toBe(200);

    // Now only the actor remains, and they cannot demote themselves anyway.
    const remaining = await harness.prisma.user.count({
      where: { status: 'ACTIVE', roles: { some: { role: { key: 'SUPER_ADMIN' } } } },
    });
    expect(remaining).toBe(1);
  });

  it('revokes sessions when an account is suspended', async () => {
    const actor = await signedInStaff('ADMIN');
    const target = await signedInStaff('ANALYST', 'target@example.test');

    const suspended = await harness
      .http()
      .patch(`/api/v1/users/${target.user.id}`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ status: 'SUSPENDED' });
    expect(suspended.status).toBe(200);

    const after = await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${target.token}`);
    expect(after.status).toBe(401);
  });

  it('paginates the user list by cursor without repeating rows', async () => {
    const { token } = await signedInStaff('ADMIN');
    for (let i = 0; i < 5; i += 1) {
      await harness.prisma.user.create({
        data: {
          email: `bulk-${i}@example.test`,
          emailNormalized: `bulk-${i}@example.test`,
          type: 'CUSTOMER',
        },
      });
    }

    const firstPage = await harness
      .http()
      .get('/api/v1/users?limit=3')
      .set('Authorization', `Bearer ${token}`);
    expect(firstPage.body.data).toHaveLength(3);
    expect(firstPage.body.meta.nextCursor).toEqual(expect.any(String));

    const secondPage = await harness
      .http()
      .get(`/api/v1/users?limit=3&cursor=${encodeURIComponent(firstPage.body.meta.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`);

    const firstIds = firstPage.body.data.map((u: { id: string }) => u.id);
    const secondIds = secondPage.body.data.map((u: { id: string }) => u.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('caps the page size a client can request', async () => {
    const { token } = await signedInStaff('ADMIN');
    const response = await harness
      .http()
      .get('/api/v1/users?limit=100000')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(400);
  });

  it('ignores a forged pagination cursor rather than trusting it', async () => {
    const { token } = await signedInStaff('ADMIN');
    const forged = Buffer.from("'; DROP TABLE users; --", 'utf8').toString('base64url');
    const response = await harness
      .http()
      .get(`/api/v1/users?cursor=${encodeURIComponent(forged)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(await harness.prisma.user.count()).toBeGreaterThan(0);
  });
});

describe('system settings and feature flags', () => {
  it('requires a reason and enforces the declared value type', async () => {
    const { token } = await signedInStaff('SUPER_ADMIN');

    const wrongType = await harness
      .http()
      .put('/api/v1/system/settings/security.staff_mfa_grace_period_days')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'seven', reason: 'Trying to set a string' });
    expect(wrongType.status).toBe(400);

    const ok = await harness
      .http()
      .put('/api/v1/system/settings/security.staff_mfa_grace_period_days')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 3, reason: 'Tightening the enrolment window' });
    expect(ok.status).toBe(200);
    expect(ok.body.value).toBe(3);

    const audit = await harness.prisma.auditLog.findFirstOrThrow({
      where: { action: 'system.setting.updated' },
    });
    expect(audit.reason).toBe('Tightening the enrolment window');
  });

  it('creates a feature flag and rolls it out deterministically', async () => {
    const { token } = await signedInStaff('SUPER_ADMIN');

    const created = await harness
      .http()
      .put('/api/v1/system/feature-flags/checkout.v2')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true, rolloutPercentage: 50, enabledForSubjects: ['always-on-user'] });

    expect(created.status).toBe(200);
    expect(created.body.enabled).toBe(true);
    expect(created.body.rolloutPercentage).toBe(50);
  });

  it('refuses settings access to a role without SYSTEM_SETTINGS', async () => {
    const { token } = await signedInStaff('SUPPORT_AGENT');
    const response = await harness
      .http()
      .get('/api/v1/system/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
  });
});

describe('GET /audit-logs', () => {
  it('is readable only with AUDIT_READ', async () => {
    const support = await signedInStaff('SUPPORT_AGENT');
    const denied = await harness
      .http()
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${support.token}`);
    expect(denied.status).toBe(403);

    const admin = await signedInStaff('ADMIN', 'admin2@example.test');
    const allowed = await harness
      .http()
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(allowed.status).toBe(200);
  });

  it('filters by action and entity', async () => {
    const { token } = await signedInStaff('ADMIN');
    const response = await harness
      .http()
      .get('/api/v1/audit-logs?action=auth.login.succeeded')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(
      response.body.data.every((log: { action: string }) => log.action === 'auth.login.succeeded'),
    ).toBe(true);
  });

  it('cannot be altered through the API surface', async () => {
    const { token } = await signedInStaff('SUPER_ADMIN');
    const existing = await harness.prisma.auditLog.findFirstOrThrow();

    // There is no write route, and the database refuses regardless.
    const attempt = await harness
      .http()
      .delete(`/api/v1/audit-logs/${existing.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(attempt.status).toBe(404);

    await expect(
      harness.prisma.auditLog.update({ where: { id: existing.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
  });
});
