import { describe, expect, it } from 'vitest';
import { allocateCents } from './commerce.js';
import { priceOrder, pricingFingerprint, PricingError, type PricingLineInput } from './pricing.js';

/**
 * The pricing engine decides what a customer is charged, so these tests are
 * about cents, not about shapes. The recurring assertion is that nothing is
 * lost or invented: line values sum to order values, exactly, whatever the
 * split.
 */

function line(overrides: Partial<PricingLineInput> = {}): PricingLineInput {
  return {
    variantId: 'variant-1',
    productId: 'product-1',
    sku: 'HC-1',
    productName: 'Magnesium Glycinate',
    variantName: '120 capsules',
    quantity: 1,
    unitPriceCents: 2400,
    taxable: true,
    ...overrides,
  };
}

describe('allocateCents', () => {
  it('splits evenly when it divides', () => {
    expect(allocateCents(300, [1, 1, 1])).toEqual([100, 100, 100]);
  });

  it('never loses a cent to rounding', () => {
    // 100 / 3 is the classic case: three shares of 33.33.
    const shares = allocateCents(100, [1, 1, 1]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
    expect(shares.sort()).toEqual([33, 33, 34]);
  });

  it('never invents a cent either', () => {
    for (const amount of [1, 7, 99, 101, 12345, 99999]) {
      for (const weights of [
        [1, 2, 3],
        [5, 5],
        [1, 1, 1, 1, 1, 1, 1],
        [100, 1],
      ]) {
        const shares = allocateCents(amount, weights);
        expect(shares.reduce((sum, share) => sum + share, 0)).toBe(amount);
      }
    }
  });

  it('weights the split by value', () => {
    // A £30 discount across a £10 and a £20 line lands 1:2.
    expect(allocateCents(3000, [1000, 2000])).toEqual([1000, 2000]);
  });

  it('is deterministic regardless of how the remainder falls', () => {
    expect(allocateCents(10, [1, 1, 1])).toEqual(allocateCents(10, [1, 1, 1]));
  });

  it('spreads evenly when every weight is zero', () => {
    // Free items still have to carry their share of a shipping allocation.
    const shares = allocateCents(10, [0, 0, 0]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(10);
  });

  it('handles a single share', () => {
    expect(allocateCents(999, [7])).toEqual([999]);
  });

  it('returns nothing for no shares', () => {
    expect(allocateCents(100, [])).toEqual([]);
  });

  it('refuses a fractional amount', () => {
    expect(() => allocateCents(10.5, [1])).toThrow(/integer/);
  });

  it('refuses negative weights', () => {
    expect(() => allocateCents(100, [1, -1])).toThrow(/non-negative/);
  });
});

describe('priceOrder', () => {
  it('prices a single line', () => {
    const result = priceOrder({ currency: 'USD', lines: [line()], shippingCents: 0 });

    expect(result.subtotalCents).toBe(2400);
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(2400);
  });

  it('multiplies by quantity', () => {
    const result = priceOrder({
      currency: 'USD',
      lines: [line({ quantity: 3, unitPriceCents: 1999 })],
      shippingCents: 0,
    });

    expect(result.lines[0]!.lineSubtotalCents).toBe(5997);
    expect(result.subtotalCents).toBe(5997);
  });

  it('adds shipping to the total but not the subtotal', () => {
    const result = priceOrder({ currency: 'USD', lines: [line()], shippingCents: 599 });

    expect(result.subtotalCents).toBe(2400);
    expect(result.shippingCents).toBe(599);
    expect(result.totalCents).toBe(2999);
  });

  describe('tax', () => {
    it('reports a null rate as "not calculated" rather than as zero tax', () => {
      // The distinction matters: a deployment with no tax engine configured must
      // not look like a jurisdiction with no sales tax.
      const result = priceOrder({ currency: 'USD', lines: [line()], shippingCents: 0 });
      expect(result.taxRateApplied).toBeNull();
      expect(result.taxCents).toBe(0);
    });

    it('applies a configured rate', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [line({ unitPriceCents: 10_000 })],
        shippingCents: 0,
        taxRate: 0.0725,
      });

      expect(result.taxCents).toBe(725);
      expect(result.totalCents).toBe(10_725);
      expect(result.taxRateApplied).toBe(0.0725);
    });

    it('does not tax a line marked non-taxable', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [line({ unitPriceCents: 10_000, taxable: false })],
        shippingCents: 0,
        taxRate: 0.1,
      });

      expect(result.taxCents).toBe(0);
      expect(result.lines[0]!.taxCents).toBe(0);
    });

    it('taxes only the taxable lines in a mixed basket', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [
          line({ variantId: 'a', unitPriceCents: 10_000, taxable: true }),
          line({ variantId: 'b', sku: 'HC-2', unitPriceCents: 10_000, taxable: false }),
        ],
        shippingCents: 0,
        taxRate: 0.1,
      });

      expect(result.taxCents).toBe(1000);
      expect(result.lines[0]!.taxCents).toBe(1000);
      expect(result.lines[1]!.taxCents).toBe(0);
    });

    it('taxes shipping only when the jurisdiction does', () => {
      const base = { currency: 'USD' as const, lines: [line()], shippingCents: 1000 };

      expect(priceOrder({ ...base, taxRate: 0.1 }).taxCents).toBe(240);
      expect(priceOrder({ ...base, taxRate: 0.1, taxShipping: true }).taxCents).toBe(340);
    });

    it('computes tax on the basket, not per line, so identical baskets agree', () => {
      // Rounding each line independently makes the total depend on how the
      // basket happens to be split. One item at $10.03, or three at $10.03,
      // must produce the tax on the sum either way.
      const single = priceOrder({
        currency: 'USD',
        lines: [line({ quantity: 3, unitPriceCents: 1003 })],
        shippingCents: 0,
        taxRate: 0.0825,
      });
      const split = priceOrder({
        currency: 'USD',
        lines: [
          line({ variantId: 'a', quantity: 1, unitPriceCents: 1003 }),
          line({ variantId: 'b', sku: 'HC-2', quantity: 1, unitPriceCents: 1003 }),
          line({ variantId: 'c', sku: 'HC-3', quantity: 1, unitPriceCents: 1003 }),
        ],
        shippingCents: 0,
        taxRate: 0.0825,
      });

      expect(single.taxCents).toBe(split.taxCents);
      expect(single.totalCents).toBe(split.totalCents);
    });

    it('allocates tax across lines so the parts sum to the whole', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [
          line({ variantId: 'a', unitPriceCents: 333 }),
          line({ variantId: 'b', sku: 'HC-2', unitPriceCents: 333 }),
          line({ variantId: 'c', sku: 'HC-3', unitPriceCents: 333 }),
        ],
        shippingCents: 0,
        taxRate: 0.0725,
      });

      const lineTaxSum = result.lines.reduce((sum, entry) => sum + entry.taxCents, 0);
      expect(lineTaxSum).toBe(result.taxCents);
    });

    it('refuses an impossible rate', () => {
      const base = { currency: 'USD' as const, lines: [line()], shippingCents: 0 };
      expect(() => priceOrder({ ...base, taxRate: -0.1 })).toThrow(PricingError);
      expect(() => priceOrder({ ...base, taxRate: 1.5 })).toThrow(PricingError);
    });
  });

  describe('discounts', () => {
    it('reduces the total', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [line({ unitPriceCents: 10_000 })],
        shippingCents: 0,
        discountCents: 1500,
      });

      expect(result.subtotalCents).toBe(10_000);
      expect(result.discountCents).toBe(1500);
      expect(result.totalCents).toBe(8500);
    });

    it('spreads across lines by value, summing exactly', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [
          line({ variantId: 'a', unitPriceCents: 1000 }),
          line({ variantId: 'b', sku: 'HC-2', unitPriceCents: 2000 }),
        ],
        shippingCents: 0,
        discountCents: 1000,
      });

      expect(result.lines.map((entry) => entry.discountCents)).toEqual([333, 667]);
      expect(result.lines.reduce((sum, entry) => sum + entry.discountCents, 0)).toBe(1000);
    });

    it('taxes the discounted amount, not the list price', () => {
      // Charging tax on money the customer did not pay is not a rounding
      // question, it is overcharging.
      const result = priceOrder({
        currency: 'USD',
        lines: [line({ unitPriceCents: 10_000 })],
        shippingCents: 0,
        discountCents: 5000,
        taxRate: 0.1,
      });

      expect(result.taxCents).toBe(500);
      expect(result.totalCents).toBe(5500);
    });

    it('refuses a discount larger than the goods', () => {
      // That is not a discount, it is a payout.
      expect(() =>
        priceOrder({
          currency: 'USD',
          lines: [line({ unitPriceCents: 1000 })],
          shippingCents: 0,
          discountCents: 1001,
        }),
      ).toThrow(/cannot exceed/);
    });

    it('allows a discount that exactly clears the goods', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [line({ unitPriceCents: 1000 })],
        shippingCents: 500,
        discountCents: 1000,
      });

      expect(result.totalCents).toBe(500);
    });
  });

  describe('validation', () => {
    it('refuses an empty order', () => {
      expect(() => priceOrder({ currency: 'USD', lines: [], shippingCents: 0 })).toThrow(
        /empty order/,
      );
    });

    it('refuses a zero or negative quantity', () => {
      for (const quantity of [0, -1]) {
        expect(() =>
          priceOrder({ currency: 'USD', lines: [line({ quantity })], shippingCents: 0 }),
        ).toThrow(/positive whole number/);
      }
    });

    it('refuses a fractional quantity', () => {
      expect(() =>
        priceOrder({ currency: 'USD', lines: [line({ quantity: 1.5 })], shippingCents: 0 }),
      ).toThrow(/positive whole number/);
    });

    it('refuses a fractional price, because money is minor units', () => {
      expect(() =>
        priceOrder({ currency: 'USD', lines: [line({ unitPriceCents: 19.99 })], shippingCents: 0 }),
      ).toThrow(/integer of cents/);
    });

    it('refuses negative money', () => {
      expect(() =>
        priceOrder({ currency: 'USD', lines: [line({ unitPriceCents: -1 })], shippingCents: 0 }),
      ).toThrow(PricingError);
      expect(() => priceOrder({ currency: 'USD', lines: [line()], shippingCents: -1 })).toThrow(
        PricingError,
      );
      expect(() =>
        priceOrder({ currency: 'USD', lines: [line()], shippingCents: 0, discountCents: -1 }),
      ).toThrow(PricingError);
    });

    it('prices a free item without complaint', () => {
      const result = priceOrder({
        currency: 'USD',
        lines: [line({ unitPriceCents: 0 })],
        shippingCents: 0,
      });
      expect(result.totalCents).toBe(0);
    });
  });

  describe('internal consistency', () => {
    it('always produces lines that sum to the order', () => {
      const cases: PricingLineInput[][] = [
        [line()],
        [line({ quantity: 7, unitPriceCents: 1 })],
        [
          line({ variantId: 'a', quantity: 2, unitPriceCents: 1237 }),
          line({ variantId: 'b', sku: 'HC-2', quantity: 5, unitPriceCents: 99 }),
          line({ variantId: 'c', sku: 'HC-3', quantity: 1, unitPriceCents: 100_000 }),
        ],
      ];

      for (const lines of cases) {
        const subtotal = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
        // A discount can never exceed the goods, so the sweep is clamped rather
        // than asserting on inputs the engine correctly refuses.
        const discounts = [0, 1, 97, 500].filter((value) => value <= subtotal);

        for (const discountCents of discounts) {
          for (const taxRate of [null, 0, 0.0625, 0.0975, 0.1]) {
            const result = priceOrder({
              currency: 'USD',
              lines,
              shippingCents: 799,
              discountCents,
              taxRate,
            });

            expect(result.lines.reduce((s, l) => s + l.lineSubtotalCents, 0)).toBe(
              result.subtotalCents,
            );
            expect(result.lines.reduce((s, l) => s + l.discountCents, 0)).toBe(
              result.discountCents,
            );
            expect(result.lines.reduce((s, l) => s + l.taxCents, 0)).toBe(result.taxCents);
            expect(result.totalCents).toBe(
              result.subtotalCents - result.discountCents + result.shippingCents + result.taxCents,
            );
            expect(result.totalCents).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });
});

describe('pricingFingerprint', () => {
  const basket = {
    currency: 'USD',
    lines: [
      { variantId: 'a', quantity: 1, unitPriceCents: 1000 },
      { variantId: 'b', quantity: 2, unitPriceCents: 500 },
    ],
    shippingCents: 599,
    discountCents: 0,
    taxCents: 150,
    totalCents: 2749,
  };

  it('is stable for the same basket', () => {
    expect(pricingFingerprint(basket)).toBe(pricingFingerprint(basket));
  });

  it('ignores line order, because a basket is a set', () => {
    expect(pricingFingerprint({ ...basket, lines: [...basket.lines].reverse() })).toBe(
      pricingFingerprint(basket),
    );
  });

  it('changes when a quantity changes', () => {
    expect(
      pricingFingerprint({
        ...basket,
        lines: [{ ...basket.lines[0]!, quantity: 2 }, basket.lines[1]!],
      }),
    ).not.toBe(pricingFingerprint(basket));
  });

  it('changes when a price changes underneath the customer', () => {
    // This is the case the fingerprint exists for: the catalogue was repriced
    // between quoting and paying, and the customer must see the new number
    // rather than be charged the old one.
    expect(
      pricingFingerprint({
        ...basket,
        lines: [{ ...basket.lines[0]!, unitPriceCents: 1200 }, basket.lines[1]!],
      }),
    ).not.toBe(pricingFingerprint(basket));
  });

  it('changes when shipping, tax or the total changes', () => {
    expect(pricingFingerprint({ ...basket, shippingCents: 0 })).not.toBe(
      pricingFingerprint(basket),
    );
    expect(pricingFingerprint({ ...basket, taxCents: 0 })).not.toBe(pricingFingerprint(basket));
    expect(pricingFingerprint({ ...basket, totalCents: 1 })).not.toBe(pricingFingerprint(basket));
  });

  it('changes when an item is removed', () => {
    expect(pricingFingerprint({ ...basket, lines: [basket.lines[0]!] })).not.toBe(
      pricingFingerprint(basket),
    );
  });

  it('is a fixed-width hex string', () => {
    expect(pricingFingerprint(basket)).toMatch(/^[0-9a-f]{16}$/);
  });
});
