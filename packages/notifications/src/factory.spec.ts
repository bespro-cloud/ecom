import { describe, expect, it } from 'vitest';
import type { ServerEnv } from '@health/config';
import { createEmailProvider, createSmsProvider } from './factory.js';

const env = (overrides: Partial<ServerEnv>): ServerEnv =>
  ({
    EMAIL_PROVIDER: 'console',
    SMS_PROVIDER: 'console',
    EMAIL_FROM: 'a@b.test',
    ...overrides,
  }) as ServerEnv;

describe('createEmailProvider', () => {
  it('returns the console adapter in development', () => {
    expect(createEmailProvider(env({})).name).toBe('console');
  });

  it('requires SMTP_URL when SMTP is selected', () => {
    expect(() => createEmailProvider(env({ EMAIL_PROVIDER: 'smtp' }))).toThrow(/SMTP_URL/);
  });

  it('constructs the SMTP adapter when configured', () => {
    const provider = createEmailProvider(
      env({ EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://user:pass@localhost:1025' }),
    );
    expect(provider.name).toBe('smtp');
  });

  it('refuses to silently fall back for a declared-but-unimplemented provider', () => {
    // A silent fallback here would mean customer mail disappearing into a log.
    expect(() => createEmailProvider(env({ EMAIL_PROVIDER: 'resend' }))).toThrow(
      /no adapter is implemented/,
    );
    expect(() => createEmailProvider(env({ EMAIL_PROVIDER: 'ses' }))).toThrow(
      /no adapter is implemented/,
    );
  });
});

describe('createSmsProvider', () => {
  it('returns the console adapter in development', () => {
    expect(createSmsProvider(env({})).name).toBe('console');
  });

  it('refuses an unimplemented provider', () => {
    expect(() => createSmsProvider(env({ SMS_PROVIDER: 'twilio' }))).toThrow(
      /no adapter is implemented/,
    );
  });
});
