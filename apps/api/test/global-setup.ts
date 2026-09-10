import { execSync } from 'node:child_process';

/**
 * Applies migrations to the integration-test database once per run.
 *
 * The suite talks to a real PostgreSQL instance; there is no schema mocking,
 * so the schema has to actually be there.
 */
export default function globalSetup(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for integration tests.');
  }
  if (!/test/i.test(databaseUrl)) {
    throw new Error(
      `Refusing to run integration tests against "${databaseUrl}" — the database name must contain "test".`,
    );
  }

  execSync('pnpm exec prisma migrate deploy --schema ../../prisma/schema.prisma', {
    cwd: __dirname + '/..',
    stdio: 'inherit',
    env: process.env,
  });
}
