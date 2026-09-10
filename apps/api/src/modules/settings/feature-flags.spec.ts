import { bucketOf } from './feature-flags.service.js';

describe('bucketOf', () => {
  it('is deterministic for a subject and flag', () => {
    expect(bucketOf('checkout.v2', 'user-1')).toBe(bucketOf('checkout.v2', 'user-1'));
  });

  it('stays inside 0-99', () => {
    for (let i = 0; i < 500; i += 1) {
      const bucket = bucketOf('checkout.v2', `user-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it('salts by flag, so a subject is not correlated across flags', () => {
    const subjects = Array.from({ length: 200 }, (_, i) => `user-${i}`);
    const a = subjects.map((s) => bucketOf('flag.a', s));
    const b = subjects.map((s) => bucketOf('flag.b', s));
    const identical = a.filter((value, index) => value === b[index]).length;
    // With independent hashes roughly 1 in 100 should coincide by chance.
    expect(identical).toBeLessThan(20);
  });

  it('distributes roughly evenly', () => {
    const subjects = Array.from({ length: 10_000 }, (_, i) => `user-${i}`);
    const inFirstDecile = subjects.filter((s) => bucketOf('checkout.v2', s) < 10).length;
    expect(inFirstDecile).toBeGreaterThan(800);
    expect(inFirstDecile).toBeLessThan(1200);
  });
});
