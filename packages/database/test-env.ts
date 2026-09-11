/**
 * Points the integration suite at the test database when nothing else has.
 *
 * CI sets `DATABASE_URL` on the job, and that always wins. This only fills the
 * gap for someone running `pnpm test` locally, where the alternative is a
 * failure that reads like a broken test rather than a missing variable.
 *
 * The name still has to contain "test" — `requireTestDatabaseUrl` enforces
 * that, because truncating the wrong database is the kind of mistake you only
 * make once.
 */
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://healthcommerce:healthcommerce@127.0.0.1:5432/health_commerce_test?schema=public';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;
}
