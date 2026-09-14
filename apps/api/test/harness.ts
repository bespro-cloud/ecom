import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { generateTotpCode, hashPassword, PASSWORD_ALGORITHM_ID } from '@health/auth';
import { createApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { seedSettings, syncRbac } from '@health/database';

export interface TestHarness {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  http: () => request.Agent;
  close: () => Promise<void>;
  reset: () => Promise<void>;
}

const TRUNCATABLE = [
  // AI first: a suggestion references an interaction, and interactions
  // reference nothing else.
  'ai_suggestions',
  'ai_interactions',

  // Growth next: analytics events reference products, and blog reviews
  // reference posts.
  'analytics_events',
  'analytics_sessions',
  'analytics_product_daily',
  'analytics_channel_daily',
  'analytics_daily_metrics',
  'analytics_salts',
  'blog_post_reviews',
  'blog_posts',
  'blog_categories',
  'redirects',

  // Lifecycle next: these reference orders, products and customers below.
  'review_moderations',
  'product_reviews',
  'coupon_redemptions',
  'coupons',
  'subscription_invoices',
  'subscription_events',
  'subscription_items',
  'subscriptions',
  'customer_payment_methods',
  'support_messages',
  'support_threads',
  'erasure_requests',

  // Compliance next: recall lots reference batches, and claim rows reference
  // the products further down.
  'recall_actions',
  'recall_lots',
  'recalls',
  'batch_events',
  'inventory_batches',
  'product_documents',
  'claim_evidence',
  'evidence_records',
  'claim_reviews',
  'product_claim_versions',
  'product_claims',

  // Commerce next: these reference the catalogue rows below them.
  'shipment_items',
  'shipments',
  'refunds',
  'payments',
  'order_events',
  'order_items',
  'orders',
  'checkouts',
  'cart_items',
  'carts',
  'inventory_adjustments',
  'inventory_reservations',
  'inventory_items',
  'warehouses',
  'shipping_rates',

  'compliance_reviews',
  'product_disclaimers',
  'product_warnings',
  'product_ingredients',
  'product_attribute_values',
  'product_categories',
  'product_images',
  'product_variants',
  'products',
  'categories',
  'product_attributes',
  'ingredient_warnings',
  'ingredient_sources',
  'ingredients',
  'seo_metadata',
  'pages',
  'media',

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

/** Tables a database trigger makes append-only. */
const APPEND_ONLY = [
  'audit_logs',
  'customer_consents',
  'compliance_reviews',
  'order_events',
  'inventory_adjustments',
  'product_claim_versions',
  'claim_reviews',
  'batch_events',
  'recall_actions',
  'recall_lots',
  'review_moderations',
  'coupon_redemptions',
  'subscription_events',
  'support_messages',
  'blog_post_reviews',
  'ai_interactions',
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
    // These are append-only, enforced by a trigger. Tests are the one place
    // that is allowed to clear them, and only by disabling the trigger
    // explicitly — which is exactly the noise we want if it ever appears
    // outside this file.
    for (const table of APPEND_ONLY) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
    }
    try {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${TRUNCATABLE.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    } finally {
      for (const table of APPEND_ONLY) {
        await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      }
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

/**
 * The settings the application actually ships with, not a test-shaped subset.
 *
 * Several of them are load-bearing — the publishing checklist reads
 * `catalog.publish_checklist`, and product creation reads the disclaimer text
 * — so seeding a reduced fixture here would mean testing a configuration no
 * deployment ever runs.
 */
async function seedBaselineSettings(prisma: PrismaService): Promise<void> {
  await seedSettings(prisma);
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

export interface SignedInStaff {
  userId: string;
  email: string;
  token: string;
  /** Present only for roles that require MFA. */
  totpSecret?: string;
}

/**
 * Creates a staff account with the given role and signs it in *completely* —
 * including MFA where the role requires it, which is the only way such a
 * session becomes privileged enough to do anything interesting.
 */
/**
 * A signed-in customer, with their `Customer` record.
 *
 * Created through Prisma rather than the registration endpoint: these tests are
 * about the lifecycle, and walking email verification for each one would make
 * the suite about Phase 1 instead.
 */
export async function signedInCustomer(
  harness: TestHarness,
  email = `customer-${Math.random().toString(36).slice(2, 8)}@example.test`,
): Promise<SignedInCustomer> {
  const role = await harness.prisma.role.findUniqueOrThrow({ where: { key: 'CUSTOMER' } });
  const user = await harness.prisma.user.create({
    data: {
      email,
      emailNormalized: email.toLowerCase(),
      passwordHash: await hashPassword(STRONG_PASSWORD),
      passwordAlgorithm: PASSWORD_ALGORITHM_ID,
      passwordUpdatedAt: new Date(),
      firstName: 'Ada',
      lastName: 'Lovelace',
      type: 'CUSTOMER',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  const customer = await harness.prisma.customer.create({
    data: {
      userId: user.id,
      reference: `CUS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    },
  });

  const login = await harness
    .http()
    .post('/api/v1/auth/login')
    .send({ email, password: STRONG_PASSWORD });

  return {
    userId: user.id,
    customerId: customer.id,
    email,
    token: login.body.accessToken as string,
  };
}

export interface SignedInCustomer {
  userId: string;
  customerId: string;
  email: string;
  token: string;
}

export async function signedInStaff(
  harness: TestHarness,
  roleKey: string,
  email = `${roleKey.toLowerCase()}@example.test`,
): Promise<SignedInStaff> {
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
    return { userId: user.id, email, token: initial.body.accessToken as string };
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
    userId: user.id,
    email,
    token: verified.body.accessToken as string,
    totpSecret: enroll.body.secret as string,
  };
}
