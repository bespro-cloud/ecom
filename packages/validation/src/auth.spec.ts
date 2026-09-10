import { describe, expect, it } from 'vitest';
import { loginSchema, mfaVerifySchema, registerSchema } from './auth.js';

const validRegistration = {
  email: 'alice@example.com',
  password: 'salted caramel harbour',
  firstName: 'Alice',
  lastName: 'Nguyen',
  acceptsTerms: true,
};

describe('registerSchema', () => {
  it('accepts a complete registration', () => {
    const parsed = registerSchema.parse(validRegistration);
    expect(parsed.acceptsMarketingEmail).toBe(false);
  });

  it('requires explicit terms acceptance', () => {
    const result = registerSchema.safeParse({ ...validRegistration, acceptsTerms: false });
    expect(result.success).toBe(false);
  });

  it('defaults marketing consent to off (opt-in, never opt-out)', () => {
    expect(registerSchema.parse(validRegistration).acceptsMarketingEmail).toBe(false);
  });

  it('enforces the minimum password length', () => {
    const result = registerSchema.safeParse({ ...validRegistration, password: 'short' });
    expect(result.success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('does not enforce the password policy on login', () => {
    // An existing account may predate a policy change; rejecting here would
    // also disclose the policy to an attacker probing the endpoint.
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'old' }).success).toBe(true);
  });

  it('still requires a non-empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('mfaVerifySchema', () => {
  it('accepts a TOTP code', () => {
    expect(mfaVerifySchema.safeParse({ challengeToken: 't', code: '123456' }).success).toBe(true);
  });

  it('accepts a recovery code', () => {
    expect(
      mfaVerifySchema.safeParse({ challengeToken: 't', recoveryCode: 'ABCDE-FGHJK' }).success,
    ).toBe(true);
  });

  it('rejects supplying both or neither', () => {
    expect(
      mfaVerifySchema.safeParse({
        challengeToken: 't',
        code: '123456',
        recoveryCode: 'ABCDE-FGHJK',
      }).success,
    ).toBe(false);
    expect(mfaVerifySchema.safeParse({ challengeToken: 't' }).success).toBe(false);
  });
});
