import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { generateTotpCode } from '@health/auth';
import { createApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { syncRbac } from '@health/database';

export interface TestHarness {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  http: () => request.Agent;
  close: () => Promise<void>;
  reset: () => Promise<void>;
}

const TRUNCATABLE = [
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
];

export async function createHarness(): Promise<TestHarness> {
  const app = await createApp();
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  // Reference data is created once; tests only ever clear mutable tables.
  await syncRbac(prisma);
  await seedBaselineSettings(prisma);

  const reset = async (): Promise<void> => {
    await prisma.$executeRawUnsafe('ALTER TABLE "audit_logs" DISABLE TRIGGER USER');
    await prisma.$executeRawUnsafe('ALTER TABLE "customer_consents" DISABLE TRIGGER USER');
    try {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${TRUNCATABLE.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "audit_logs" ENABLE TRIGGER USER');
      await prisma.$executeRawUnsafe('ALTER TABLE "customer_consents" ENABLE TRIGGER USER');
    }
    // Rate-limit counters and single-use MFA nonces live in Redis; leaving them
    // behind would make tests order-dependent.
    const keys = await redis.client.keys(`${redis.key('*')}`);
    if (keys.length > 0) await redis.client.del(...keys);
  };

  return {
    app,
    prisma,
    redis,
    http: () => request.agent(app.getHttpServer() as App),
    close: async () => {
      await app.close();
    },
    reset,
  };
}

async function seedBaselineSettings(prisma: PrismaService): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: 'security.staff_mfa_grace_period_days' },
    update: {},
    create: {
      key: 'security.staff_mfa_grace_period_days',
      value: 7,
      valueType: 'NUMBER',
      description: 'Test fixture.',
    },
  });
}

/**
 * Produces a TOTP code that the server will accept *and* that has not been
 * spent yet.
 *
 * Successful verification advances the factor's counter, so a second code
 * generated inside the same 30-second step is correctly rejected as a replay.
 * Stepping forward by one period keeps the code inside the ±1 drift window
 * while guaranteeing a higher counter — which is exactly what a real
 * authenticator app would produce a moment later.
 */
export function nextTotpCode(secret: string, offsetPeriods = 1): string {
  return generateTotpCode(secret, new Date(Date.now() + offsetPeriods * 30_000));
}

export const STRONG_PASSWORD = 'salted caramel harbour lantern';
