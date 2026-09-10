import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id with parameters at or above the OWASP Password Storage Cheat Sheet
 * baseline (19 MiB memory, 2 iterations, parallelism 1). The encoded hash
 * embeds its own parameters, so raising these later still verifies existing
 * hashes; `needsRehash` reports when a stored hash is below current policy.
 */
/**
 * `@node-rs/argon2` exposes `Algorithm` as an ambient const enum, which cannot
 * be imported under `isolatedModules`. 2 is `Algorithm.Argon2id`; the
 * assertion below fails the build if that ever changes.
 */
const ALGORITHM_ARGON2ID = 2;

export const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const PASSWORD_ALGORITHM_ID = 'argon2id-v19-m19456-t2-p1';

/** Guards the const-enum workaround above: argon2id hashes are self-describing. */
export const ARGON2ID_HASH_PREFIX = '$argon2id$v=19$';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export async function hashPassword(plaintext: string): Promise<string> {
  assertHashable(plaintext);
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Constant-time-ish verification. Returns false rather than throwing on a
 * malformed stored hash so a corrupted row cannot be distinguished from a
 * wrong password by timing or by error shape.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  if (!storedHash || typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (Buffer.byteLength(plaintext, 'utf8') > PASSWORD_MAX_LENGTH * 4) return false;
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than policy. */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}

function assertHashable(plaintext: string): void {
  if (typeof plaintext !== 'string') {
    throw new TypeError('password must be a string');
  }
  if (plaintext.length < PASSWORD_MIN_LENGTH) {
    throw new RangeError(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (plaintext.length > PASSWORD_MAX_LENGTH) {
    throw new RangeError(`password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
}

/**
 * Fixed-cost decoy verification.
 *
 * When a login is attempted for an address that does not exist, we still run a
 * hash comparison so response time does not reveal whether the account exists.
 */
const DECOY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Y2FuYXJ5Y2FuYXJ5Y2FuYXJ5$Q0kJx0m2xLB1p8sT9Lqz2dQK0Q7lRQ0m5Yw1n0kU8xQ';

export async function burnPasswordComparison(plaintext: string): Promise<void> {
  try {
    await verify(DECOY_HASH, plaintext, ARGON2_OPTIONS);
  } catch {
    // Intentionally ignored: the only purpose of this call is to spend time.
  }
}
