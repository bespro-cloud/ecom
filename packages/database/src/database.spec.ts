import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLES } from '@health/types';
import { createTestPrismaClient, truncateAll } from './testing.js';
import { isUniqueConstraintError, type PrismaClient } from './client.js';
import { syncRbac } from './seed/rbac.js';

/**
 * Integration tests against a real PostgreSQL instance.
 *
 * These verify the guarantees the application relies on but cannot enforce by
 * itself: append-only triggers, partial unique indexes and RBAC convergence.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createTestPrismaClient();
  await prisma.$connect();
  await syncRbac(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

async function createUser(email: string) {
  return prisma.user.create({
    data: { email, emailNormalized: email.toLowerCase(), type: 'CUSTOMER' },
  });
}

describe('RBAC sync', () => {
  it('creates the full catalogue', async () => {
    const permissions = await prisma.permission.count();
    const roles = await prisma.role.count();
    expect(permissions).toBe(PERMISSIONS.length);
    expect(roles).toBeGreaterThanOrEqual(SYSTEM_ROLES.length);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const result = await syncRbac(prisma);
    expect(result).toEqual({
      permissionsCreated: 0,
      permissionsUpdated: 0,
      rolesCreated: 0,
      rolesUpdated: 0,
      grantsAdded: 0,
      grantsRemoved: 0,
    });
  });

  it('revokes a grant that is no longer in the catalogue', async () => {
    const analyst = await prisma.role.findUniqueOrThrow({ where: { key: 'ANALYST' } });
    const refundIssue = await prisma.permission.findUniqueOrThrow({
      where: { key: 'REFUND_ISSUE' },
    });
    // Simulate drift: someone granted a dangerous permission directly in SQL.
    await prisma.rolePermission.create({
      data: { roleId: analyst.id, permissionId: refundIssue.id },
    });

    const result = await syncRbac(prisma);
    expect(result.grantsRemoved).toBe(1);

    const stillGranted = await prisma.rolePermission.findFirst({
      where: { roleId: analyst.id, permissionId: refundIssue.id },
    });
    expect(stillGranted).toBeNull();
  });

  it('marks privileged roles as requiring MFA', async () => {
    const privileged = await prisma.role.findMany({
      where: { key: { in: ['SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_REVIEWER'] } },
    });
    expect(privileged).toHaveLength(3);
    expect(privileged.every((r) => r.requiresMfa)).toBe(true);
  });

  it('gives only COMPLIANCE_REVIEWER and SUPER_ADMIN claim approval', async () => {
    const grants = await prisma.rolePermission.findMany({
      where: { permission: { key: 'CLAIM_APPROVE' } },
      include: { role: { select: { key: true } } },
    });
    expect(grants.map((g) => g.role.key).sort()).toEqual(['COMPLIANCE_REVIEWER', 'SUPER_ADMIN']);
  });

  it('does not grant the customer role any admin permission', async () => {
    const customer = await prisma.role.findUniqueOrThrow({
      where: { key: 'CUSTOMER' },
      include: { permissions: true },
    });
    expect(customer.permissions).toHaveLength(0);
  });
});

describe('audit_logs append-only trigger', () => {
  it('accepts inserts', async () => {
    const log = await prisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'test.performed', entityType: 'test' },
    });
    expect(log.id).toBeTruthy();
  });

  it('refuses updates', async () => {
    const log = await prisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'test.performed', entityType: 'test' },
    });
    await expect(
      prisma.auditLog.update({ where: { id: log.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses deletes', async () => {
    const log = await prisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'test.performed', entityType: 'test' },
    });
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);
  });

  it('refuses bulk deletes', async () => {
    await prisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'test.performed', entityType: 'test' },
    });
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe('customer_consents append-only trigger', () => {
  it('records withdrawal as a new row instead of mutating the grant', async () => {
    const user = await createUser('consent@example.test');
    const customer = await prisma.customer.create({
      data: { userId: user.id, reference: 'TEST-0001' },
    });

    const granted = await prisma.customerConsent.create({
      data: { customerId: customer.id, type: 'MARKETING_EMAIL', granted: true },
    });

    await expect(
      prisma.customerConsent.update({ where: { id: granted.id }, data: { granted: false } }),
    ).rejects.toThrow(/append-only/);

    await prisma.customerConsent.create({
      data: { customerId: customer.id, type: 'MARKETING_EMAIL', granted: false },
    });

    const history = await prisma.customerConsent.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => h.granted)).toEqual([true, false]);
  });
});

describe('email uniqueness', () => {
  it('rejects a second account with the same normalised address', async () => {
    await createUser('Alice@example.test');
    await expect(
      prisma.user.create({
        data: {
          email: 'ALICE@example.test',
          emailNormalized: 'alice@example.test',
          type: 'CUSTOMER',
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isUniqueConstraintError(error));
  });
});

describe('default address partial unique index', () => {
  it('permits only one default shipping address per customer', async () => {
    const user = await createUser('addresses@example.test');
    const customer = await prisma.customer.create({
      data: { userId: user.id, reference: 'TEST-0002' },
    });

    const base = {
      customerId: customer.id,
      firstName: 'A',
      lastName: 'B',
      line1: '1 Main St',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    };

    await prisma.customerAddress.create({ data: { ...base, isDefaultShipping: true } });
    await expect(
      prisma.customerAddress.create({ data: { ...base, isDefaultShipping: true } }),
    ).rejects.toSatisfy((error: unknown) => isUniqueConstraintError(error));
  });

  it('ignores soft-deleted addresses when enforcing the constraint', async () => {
    const user = await createUser('addresses2@example.test');
    const customer = await prisma.customer.create({
      data: { userId: user.id, reference: 'TEST-0003' },
    });
    const base = {
      customerId: customer.id,
      firstName: 'A',
      lastName: 'B',
      line1: '1 Main St',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    };

    const first = await prisma.customerAddress.create({
      data: { ...base, isDefaultShipping: true },
    });
    await prisma.customerAddress.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });

    const second = await prisma.customerAddress.create({
      data: { ...base, isDefaultShipping: true },
    });
    expect(second.id).not.toBe(first.id);
  });
});

describe('webhook idempotency constraint', () => {
  it('rejects a redelivered event with the same provider id', async () => {
    await prisma.webhookEvent.create({
      data: {
        provider: 'stripe',
        externalId: 'evt_123',
        eventType: 'payment_intent.succeeded',
        payload: {},
      },
    });
    await expect(
      prisma.webhookEvent.create({
        data: {
          provider: 'stripe',
          externalId: 'evt_123',
          eventType: 'payment_intent.succeeded',
          payload: {},
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isUniqueConstraintError(error));
  });

  it('allows the same id from a different provider', async () => {
    await prisma.webhookEvent.create({
      data: { provider: 'stripe', externalId: 'evt_123', eventType: 'a', payload: {} },
    });
    const other = await prisma.webhookEvent.create({
      data: { provider: 'shipbob', externalId: 'evt_123', eventType: 'a', payload: {} },
    });
    expect(other.id).toBeTruthy();
  });
});

describe('session rotation chain', () => {
  it('links a rotated session to exactly one successor', async () => {
    const user = await createUser('sessions@example.test');
    const familyId = crypto.randomUUID();
    const first = await prisma.userSession.create({
      data: {
        userId: user.id,
        familyId,
        refreshTokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const second = await prisma.userSession.create({
      data: {
        userId: user.id,
        familyId,
        refreshTokenHash: 'hash-2',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.userSession.update({
      where: { id: first.id },
      data: { rotatedToId: second.id, revokedAt: new Date(), revokedReason: 'ROTATED' },
    });

    const third = await prisma.userSession.create({
      data: {
        userId: user.id,
        familyId,
        refreshTokenHash: 'hash-3',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    // rotatedToId is unique, so two sessions cannot claim the same successor.
    await expect(
      prisma.userSession.update({ where: { id: third.id }, data: { rotatedToId: second.id } }),
    ).rejects.toSatisfy((error: unknown) => isUniqueConstraintError(error));
  });
});
