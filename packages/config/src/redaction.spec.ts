import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone, redactObject, truncateIp } from './redaction.js';

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a****@example.com');
  });

  it('handles values that are not addresses', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });
});

describe('maskPhone', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhone('+1 (555) 010-1234')).toBe('*******1234');
  });
});

describe('truncateIp', () => {
  it('truncates IPv4 to /24', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0');
  });

  it('unwraps IPv4-mapped IPv6', () => {
    expect(truncateIp('::ffff:203.0.113.42')).toBe('203.0.113.0');
  });

  it('truncates IPv6 to /48', () => {
    expect(truncateIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234::');
  });

  it('returns null for missing input', () => {
    expect(truncateIp(undefined)).toBeNull();
  });
});

describe('redactObject', () => {
  it('redacts sensitive keys at any depth and masks identifiers', () => {
    const result = redactObject({
      email: 'bob@example.com',
      phone: '5550101234',
      nested: { password: 'hunter2', refreshToken: 'abc', keep: 'value' },
      list: [{ cvv: '123' }],
    }) as Record<string, any>;

    expect(result.email).toBe('b**@example.com');
    expect(result.phone).toBe('******1234');
    expect(result.nested.password).toBe('[Redacted]');
    expect(result.nested.refreshToken).toBe('[Redacted]');
    expect(result.nested.keep).toBe('value');
    expect(result.list[0].cvv).toBe('[Redacted]');
  });

  it('stops runaway recursion', () => {
    const deep: any = {};
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    expect(() => redactObject(deep)).not.toThrow();
  });
});
