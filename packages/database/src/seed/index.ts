import { createPrismaClient } from '../client.js';
import { syncRbac } from './rbac.js';
import { seedSettings } from './settings.js';
import { seedDevelopmentAccounts, SEED_ACCOUNTS, SEED_CUSTOMER } from './development.js';
import { seedCatalogue } from './catalogue.js';
import { seedCommerce } from './commerce.js';

/**
 * Full development seed: reference data (safe everywhere) followed by
 * development fixtures (refused in production).
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');

  const prisma = createPrismaClient({ databaseUrl });
  try {
    console.log('Syncing RBAC catalogue...');
    const rbac = await syncRbac(prisma);
    console.log(
      `  permissions: +${rbac.permissionsCreated} ~${rbac.permissionsUpdated} | ` +
        `roles: +${rbac.rolesCreated} ~${rbac.rolesUpdated} | ` +
        `grants: +${rbac.grantsAdded} -${rbac.grantsRemoved}`,
    );

    console.log('Seeding baseline settings and feature flags...');
    await seedSettings(prisma);

    if (process.env.NODE_ENV === 'production') {
      console.log('NODE_ENV=production — skipping development fixtures.');
      return;
    }

    console.log('Seeding development accounts...');
    await seedDevelopmentAccounts(prisma);

    console.log('Seeding development catalogue...');
    await seedCatalogue(prisma);

    // After the catalogue: stock records are created per variant, so the
    // variants have to exist first.
    console.log('Seeding warehouses, stock and shipping rates...');
    await seedCommerce(prisma);

    console.log('\nDevelopment accounts (NOT for production use):');
    for (const account of SEED_ACCOUNTS) {
      console.log(
        `  ${account.email.padEnd(28)} ${account.password.padEnd(30)} ${account.roles.join(', ')}`,
      );
    }
    console.log(
      `  ${SEED_CUSTOMER.email.padEnd(28)} ${SEED_CUSTOMER.password.padEnd(30)} CUSTOMER`,
    );
    console.log('\nStaff accounts with privileged roles must enrol MFA on first sign-in.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
