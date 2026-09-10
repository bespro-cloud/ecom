import { createPrismaClient } from '../client.js';
import { syncRbac } from './rbac.js';
import { seedSettings } from './settings.js';

/**
 * Reference-data sync only. Safe to run on every deploy, including production:
 * it creates no accounts and no fixtures.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');

  const prisma = createPrismaClient({ databaseUrl });
  try {
    const result = await syncRbac(prisma);
    await seedSettings(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('RBAC sync failed:', error);
  process.exitCode = 1;
});
