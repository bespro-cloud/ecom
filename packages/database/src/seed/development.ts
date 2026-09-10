import { hashPassword, PASSWORD_ALGORITHM_ID } from '@health/auth';
import type { PrismaClient } from '../client.js';

/**
 * Development and test fixtures.
 *
 * Everything created here is explicitly labelled as non-production data. The
 * seed refuses to run when NODE_ENV is production — a seeded administrator
 * with a known password is exactly the kind of account that must never exist
 * on a live system.
 */

export const SEED_MARKER = '[DEV SEED] ';

export interface SeededAccount {
  email: string;
  password: string;
  roles: string[];
}

/**
 * Passwords are read from the environment when provided so a shared dev
 * environment can use non-obvious values; otherwise a clearly-marked local
 * default is used.
 */
function seedPassword(envKey: string, fallback: string): string {
  return process.env[envKey] ?? fallback;
}

export const SEED_ACCOUNTS: SeededAccount[] = [
  {
    email: 'superadmin@dev.local',
    password: seedPassword('SEED_SUPERADMIN_PASSWORD', 'dev-superadmin-passphrase'),
    roles: ['SUPER_ADMIN'],
  },
  {
    email: 'admin@dev.local',
    password: seedPassword('SEED_ADMIN_PASSWORD', 'dev-admin-passphrase'),
    roles: ['ADMIN'],
  },
  {
    email: 'compliance@dev.local',
    password: seedPassword('SEED_COMPLIANCE_PASSWORD', 'dev-compliance-passphrase'),
    roles: ['COMPLIANCE_REVIEWER'],
  },
  {
    email: 'product@dev.local',
    password: seedPassword('SEED_PRODUCT_PASSWORD', 'dev-product-passphrase'),
    roles: ['PRODUCT_MANAGER'],
  },
  {
    email: 'orders@dev.local',
    password: seedPassword('SEED_ORDERS_PASSWORD', 'dev-orders-passphrase'),
    roles: ['ORDER_MANAGER'],
  },
  {
    email: 'warehouse@dev.local',
    password: seedPassword('SEED_WAREHOUSE_PASSWORD', 'dev-warehouse-passphrase'),
    roles: ['WAREHOUSE_MANAGER'],
  },
  {
    email: 'support@dev.local',
    password: seedPassword('SEED_SUPPORT_PASSWORD', 'dev-support-passphrase'),
    roles: ['SUPPORT_AGENT'],
  },
];

export const SEED_CUSTOMER = {
  email: 'customer@dev.local',
  password: seedPassword('SEED_CUSTOMER_PASSWORD', 'dev-customer-passphrase'),
};

export class ProductionSeedRefusedError extends Error {
  constructor() {
    super(
      'Refusing to create development accounts: NODE_ENV is production. ' +
        'Production administrators must be provisioned through the invite flow.',
    );
    this.name = 'ProductionSeedRefusedError';
  }
}

export async function seedDevelopmentAccounts(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new ProductionSeedRefusedError();
  }

  for (const account of SEED_ACCOUNTS) {
    await upsertStaffAccount(prisma, account);
  }

  await upsertCustomerAccount(prisma, SEED_CUSTOMER);
}

async function upsertStaffAccount(prisma: PrismaClient, account: SeededAccount): Promise<void> {
  const passwordHash = await hashPassword(account.password);
  const emailNormalized = account.email.toLowerCase();
  const [firstName] = account.email.split('@');

  const roles = await prisma.role.findMany({ where: { key: { in: account.roles } } });
  if (roles.length !== account.roles.length) {
    const found = new Set(roles.map((r) => r.key));
    const missing = account.roles.filter((r) => !found.has(r));
    throw new Error(
      `Cannot seed ${account.email}: roles not found (${missing.join(', ')}). Run the RBAC sync first.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { emailNormalized },
      update: {
        passwordHash,
        passwordAlgorithm: PASSWORD_ALGORITHM_ID,
        status: 'ACTIVE',
      },
      create: {
        email: account.email,
        emailNormalized,
        passwordHash,
        passwordAlgorithm: PASSWORD_ALGORITHM_ID,
        passwordUpdatedAt: new Date(),
        firstName: `${SEED_MARKER}${firstName}`,
        lastName: 'Staff',
        type: 'STAFF',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    await tx.userRole.deleteMany({ where: { userId: user.id } });
    await tx.userRole.createMany({
      data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
      skipDuplicates: true,
    });
  });
}

async function upsertCustomerAccount(
  prisma: PrismaClient,
  account: { email: string; password: string },
): Promise<void> {
  const passwordHash = await hashPassword(account.password);
  const emailNormalized = account.email.toLowerCase();
  const customerRole = await prisma.role.findUnique({ where: { key: 'CUSTOMER' } });
  if (!customerRole) throw new Error('CUSTOMER role missing. Run the RBAC sync first.');

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { emailNormalized },
      update: { passwordHash, passwordAlgorithm: PASSWORD_ALGORITHM_ID, status: 'ACTIVE' },
      create: {
        email: account.email,
        emailNormalized,
        passwordHash,
        passwordAlgorithm: PASSWORD_ALGORITHM_ID,
        passwordUpdatedAt: new Date(),
        firstName: `${SEED_MARKER}Test`,
        lastName: 'Customer',
        type: 'CUSTOMER',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    await tx.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: customerRole.id } },
      update: {},
      create: { userId: user.id, roleId: customerRole.id },
    });

    const customer = await tx.customer.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        reference: 'DEV-CUST-0001',
        acceptsMarketingEmail: false,
        acceptsMarketingSms: false,
      },
    });

    const existingAddress = await tx.customerAddress.findFirst({
      where: { customerId: customer.id, deletedAt: null },
    });
    if (!existingAddress) {
      await tx.customerAddress.create({
        data: {
          customerId: customer.id,
          type: 'SHIPPING',
          label: `${SEED_MARKER}Home`,
          firstName: 'Test',
          lastName: 'Customer',
          line1: '350 Fifth Avenue',
          line2: 'Suite 200',
          city: 'New York',
          region: 'NY',
          postalCode: '10118',
          country: 'US',
          isDefaultShipping: true,
          isDefaultBilling: true,
        },
      });
    }

    await tx.customerConsent.create({
      data: {
        customerId: customer.id,
        type: 'TERMS_OF_SERVICE',
        granted: true,
        documentVersion: 'dev-seed',
        source: 'seed',
      },
    });
  });
}
