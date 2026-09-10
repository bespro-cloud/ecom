import { describe, expect, it } from 'vitest';
import { addressSchema } from './customers.js';

const validAddress = {
  firstName: 'Alice',
  lastName: 'Nguyen',
  line1: '350 Fifth Avenue',
  city: 'New York',
  region: 'NY',
  postalCode: '10118',
};

describe('addressSchema', () => {
  it('accepts a US address and applies defaults', () => {
    const parsed = addressSchema.parse(validAddress);
    expect(parsed.country).toBe('US');
    expect(parsed.type).toBe('SHIPPING');
    expect(parsed.isDefaultShipping).toBe(false);
  });

  it('rejects non-US destinations rather than silently accepting them', () => {
    const result = addressSchema.safeParse({ ...validAddress, region: 'NY', country: 'CA' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid ZIP', () => {
    expect(addressSchema.safeParse({ ...validAddress, postalCode: 'ABCDE' }).success).toBe(false);
  });

  it('requires a street address', () => {
    expect(addressSchema.safeParse({ ...validAddress, line1: '   ' }).success).toBe(false);
  });
});
