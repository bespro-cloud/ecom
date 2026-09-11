import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads `apps/worker/.env.test` into `process.env`.
 *
 * Existing variables always win, so CI — which sets the database and Redis
 * URLs on the job — is unaffected, and this only fills the gap for someone
 * running `pnpm test:integration` on their own machine. Without it the suite
 * fails with "DATABASE_URL must be set", which reads like a broken test rather
 * than a missing local variable.
 *
 * No `dotenv` dependency: this parses `KEY=value`, which is all the file
 * contains, and a test helper is not a good reason to add a package.
 */
export function loadTestEnv(): void {
  const path = join(__dirname, '..', '.env.test');
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
