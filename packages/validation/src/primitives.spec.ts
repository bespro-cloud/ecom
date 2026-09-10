import { describe, expect, it } from 'vitest';
import {
  emailSchema,
  normalizeEmail,
  paginationSchema,
  phoneSchema,
  slugSchema,
  totpCodeSchema,
  usPostalCodeSchema,
  usStateSchema,
} from './primitives.js';

describe('emailSchema', () => {
  it('trims surrounding whitespace', () => {
    expect(emailSchema.parse('  alice@example.com ')).toBe('alice@example.com');
  });

  it('rejects malformed addresses', () => {
    expect(emailSchema.safeParse('alice@').success).toBe(false);
    expect(emailSchema.safeParse('not an email').success).toBe(false);
  });

  it('rejects addresses beyond the RFC length limit', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('lower-cases and trims so case variants cannot become two accounts', () => {
    expect(normalizeEmail(' Alice@Example.COM ')).toBe('alice@example.com');
  });
});

describe('phoneSchema', () => {
  it('accepts E.164', () => {
    expect(phoneSchema.parse('+12125550123')).toBe('+12125550123');
  });

  it('rejects local formatting', () => {
    expect(phoneSchema.safeParse('(212) 555-0123').success).toBe(false);
    expect(phoneSchema.safeParse('+0123456789').success).toBe(false);
  });
});

describe('totpCodeSchema', () => {
  it('strips user formatting', () => {
    expect(totpCodeSchema.parse('123 456')).toBe('123456');
    expect(totpCodeSchema.parse('123-456')).toBe('123456');
  });

  it('rejects anything that is not six digits', () => {
    expect(totpCodeSchema.safeParse('12345').success).toBe(false);
    expect(totpCodeSchema.safeParse('abcdef').success).toBe(false);
  });
});

describe('usStateSchema / usPostalCodeSchema', () => {
  it('accepts states and territories', () => {
    expect(usStateSchema.parse('NY')).toBe('NY');
    expect(usStateSchema.parse('PR')).toBe('PR');
  });

  it('rejects non-US regions', () => {
    expect(usStateSchema.safeParse('ON').success).toBe(false);
  });

  it('accepts ZIP and ZIP+4', () => {
    expect(usPostalCodeSchema.parse('10001')).toBe('10001');
    expect(usPostalCodeSchema.parse('10001-1234')).toBe('10001-1234');
    expect(usPostalCodeSchema.safeParse('1000').success).toBe(false);
  });
});

describe('slugSchema', () => {
  it('normalises case and validates shape', () => {
    expect(slugSchema.parse('Vitamin-D3')).toBe('vitamin-d3');
    expect(slugSchema.safeParse('bad slug').success).toBe(false);
    expect(slugSchema.safeParse('-leading').success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('defaults the page size', () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 25 });
  });

  it('coerces a string limit from the query string', () => {
    expect(paginationSchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps the page size so a client cannot request the whole table', () => {
    expect(paginationSchema.safeParse({ limit: 5000 }).success).toBe(false);
  });
});
