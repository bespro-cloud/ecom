import { createPrismaClient, type PrismaClient } from './client.js';

/**
 * Helpers for integration tests that run against a real PostgreSQL instance.
 *
 * There is deliberately no in-memory or mocked database: the behaviour we most
 * need to trust — transactions, unique constraints, the append-only triggers,
 * `SELECT ... FOR UPDATE` — only exists in the real engine.
 */

/** Tables truncated between tests, ordered so FK cascades are irrelevant. */
const TRUNCATABLE_TABLES = [
  'audit_logs',
  'customer_consents',
  'customer_addresses',
  'customers',
  'user_mfa_recovery_codes',
  'user_mfa_factors',
  'user_tokens',
  'user_sessions',
  'user_roles',
  'users',
  'outbox_messages',
  'webhook_events',
] as const;

export function requireTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set to run integration tests.');
  }
  // Guard rail: truncating the wrong database is the kind of mistake that only
  // has to happen once.
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to run destructive integration tests against "${url}". ` +
        'The database name must contain "test".',
    );
  }
  return url;
}

export function createTestPrismaClient(): PrismaClient {
  return createPrismaClient({ databaseUrl: requireTestDatabaseUrl() });
}

/**
 * Empties the mutable tables. RBAC reference data (roles, permissions) is left
 * in place because it is created by the migration/sync step, not by tests.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  requireTestDatabaseUrl();
  // ALTER TABLE ... DISABLE TRIGGER is needed because the append-only triggers
  // would otherwise refuse the DELETE.
  await prisma.$executeRawUnsafe('ALTER TABLE "audit_logs" DISABLE TRIGGER USER');
  await prisma.$executeRawUnsafe('ALTER TABLE "customer_consents" DISABLE TRIGGER USER');
  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${TRUNCATABLE_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "audit_logs" ENABLE TRIGGER USER');
    await prisma.$executeRawUnsafe('ALTER TABLE "customer_consents" ENABLE TRIGGER USER');
  }
}
