/**
 * Per-suite defaults.
 *
 * Argon2id hashing is deliberately slow, and each test that signs in pays that
 * cost, so the default Jest timeout is not enough.
 */
jest.setTimeout(60_000);
