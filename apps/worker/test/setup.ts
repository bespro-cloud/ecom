import { loadTestEnv } from './load-env.js';

/**
 * Per-suite defaults.
 *
 * The environment is loaded here rather than left to the shell: running
 * `pnpm test:integration` on a developer's machine otherwise fails with
 * "DATABASE_URL must be set", which reads like a broken test rather than a
 * missing local variable. Anything already in the environment wins, so CI is
 * unaffected.
 */
loadTestEnv();

jest.setTimeout(60_000);
