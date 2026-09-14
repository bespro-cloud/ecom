import {
  allocateCents,
  type Currency,
  type PricedLine,
  type PricedOrder,
  type ShippingQuote,
} from './commerce.js';

/**
 * The pricing engine.
 *
 * Deliberately a pure function over explicit inputs, with no database access
 * and no clock. That is what makes it exhaustively testable, and what lets the
 * same code price a cart preview, a checkout quote and the order that is
 * finally written — three places that must agree to the cent.
 *
 * **Nothing here ever reads a price from the client.** Every input comes from
 * the catalogue or from configuration. A request that says "this costs $0" gets
 * priced at the catalogue price like everything else; there is no field it
 * could set to be believed.
 *
 * Tax is computed from a supplied rate rather than guessed. US sales tax is
 * origin/destination-dependent, jurisdiction-specific, and product-category
 * specific — getting it right is a tax-engine integration, not arithmetic.
 * Until that engine exists the rate is configuration, and a deployment that has
 * not configured one prices tax at zero *and says so*, rather than inventing a
 * plausible-looking number.
 */

export interface PricingInput {
  currency: Currency;
  lines: PricingLineInput[];
  /** Shipping already chosen and quoted, in minor units. */
  shippingCents: number;
  /**
   * Order-level discount in minor units, already validated against whatever
   * produced it. Spread across lines proportionally.
   */
  discountCents?: number;
  /**
   * Fractional tax rate for the destination, e.g. 0.0725. `null` means no rate
   * is configured, which prices tax at zero and is reported as
   * `taxRateApplied: null` so a caller can tell "no tax" from "tax not
   * calculated".
   */
  taxRate?: number | null;
  /** Whether the chosen shipping method is itself taxable in this jurisdiction. */
  taxShipping?: boolean;
}

export interface PricingLineInput {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  variantName: string;
  quantity: number;
  /** From the catalogue. Never from the request body. */
  unitPriceCents: number;
  /** Some product types are not taxable in some jurisdictions. */
  taxable: boolean;
}

export interface PricingResult extends PricedOrder {
  /** Null when no rate was configured, so "zero tax" is distinguishable. */
  taxRateApplied: number | null;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

export function priceOrder(input: PricingInput): PricingResult {
  const { currency, lines, shippingCents } = input;
  const discountCents = input.discountCents ?? 0;
  const taxRate = input.taxRate ?? null;

  if (lines.length === 0) {
    throw new PricingError('Cannot price an empty order.');
  }
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new PricingError(`Quantity for ${line.sku} must be a positive whole number.`);
    }
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new PricingError(`Price for ${line.sku} must be a non-negative integer of cents.`);
    }
  }
  if (!Number.isInteger(shippingCents) || shippingCents < 0) {
    throw new PricingError('Shipping must be a non-negative integer of cents.');
  }
  if (!Number.isInteger(discountCents) || discountCents < 0) {
    throw new PricingError('Discount must be a non-negative integer of cents.');
  }
  if (taxRate !== null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1)) {
    throw new PricingError('Tax rate must be a fraction between 0 and 1.');
  }

  const lineSubtotals = lines.map((line) => line.unitPriceCents * line.quantity);
  const subtotalCents = lineSubtotals.reduce((sum, value) => sum + value, 0);

  if (discountCents > subtotalCents) {
    // A discount larger than the goods would make the order negative, which is
    // not a discount — it is a payout.
    throw new PricingError('A discount cannot exceed the order subtotal.');
  }

  // Spread the order-level discount across lines by value, so each line carries
  // its share and the shares sum exactly to the discount.
  const discountShares = allocateCents(discountCents, lineSubtotals);

  const taxableBases = lines.map((line, index) =>
    line.taxable ? lineSubtotals[index]! - discountShares[index]! : 0,
  );

  // Tax is computed once on the total taxable base and then allocated, rather
  // than rounded per line and summed. Rounding each line independently makes
  // the order total depend on how the basket happens to be split, which is how
  // two identical baskets end up with different totals.
  const shippingIsTaxable = (input.taxShipping ?? false) && taxRate !== null;
  const taxableTotal =
    taxableBases.reduce((sum, value) => sum + value, 0) + (shippingIsTaxable ? shippingCents : 0);

  const taxCents = taxRate === null ? 0 : Math.round(taxableTotal * taxRate);
  const lineTaxShares = allocateCents(
    // Shipping tax is not attributed to any line; it is part of the order total.
    taxRate === null ? 0 : taxCents - (shippingIsTaxable ? Math.round(shippingCents * taxRate) : 0),
    taxableBases,
  );

  const pricedLines: PricedLine[] = lines.map((line, index) => {
    const lineSubtotal = lineSubtotals[index]!;
    const lineDiscount = discountShares[index]!;
    const lineTax = lineTaxShares[index]!;

    return {
      variantId: line.variantId,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      variantName: line.variantName,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineSubtotalCents: lineSubtotal,
      discountCents: lineDiscount,
      taxCents: lineTax,
      lineTotalCents: lineSubtotal - lineDiscount + lineTax,
    };
  });

  const totalCents = subtotalCents - discountCents + shippingCents + taxCents;

  const result: PricingResult = {
    currency,
    lines: pricedLines,
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents,
    taxRateApplied: taxRate,
    fingerprint: pricingFingerprint({
      currency,
      lines: pricedLines,
      shippingCents,
      discountCents,
      taxCents,
      totalCents,
    }),
  };

  assertConsistent(result);
  return result;
}

/**
 * Re-checks the arithmetic before the result leaves this module.
 *
 * The database enforces the same rules, but by then the customer has already
 * seen the number. Failing here turns a wrong total into a 500 that gets fixed,
 * rather than an invoice that has to be reissued.
 */
function assertConsistent(result: PricingResult): void {
  const lineSum = result.lines.reduce((sum, line) => sum + line.lineSubtotalCents, 0);
  if (lineSum !== result.subtotalCents) {
    throw new PricingError('Line subtotals do not sum to the order subtotal.');
  }

  const discountSum = result.lines.reduce((sum, line) => sum + line.discountCents, 0);
  if (discountSum !== result.discountCents) {
    throw new PricingError('Line discounts do not sum to the order discount.');
  }

  const expectedTotal =
    result.subtotalCents - result.discountCents + result.shippingCents + result.taxCents;
  if (expectedTotal !== result.totalCents) {
    throw new PricingError('The order total does not follow from its parts.');
  }

  if (result.totalCents < 0) {
    throw new PricingError('An order total cannot be negative.');
  }
}

/**
 * A stable identity for a priced basket.
 *
 * Deliberately covers what the customer agreed to pay — the items, their
 * quantities and prices, and every total — and nothing else. A change to any of
 * those produces a different fingerprint, and checkout refuses to charge
 * against a stale quote.
 *
 * Not a security token: it is not secret and is not signed. It answers "is this
 * still the same basket?", not "did this come from us".
 */
export function pricingFingerprint(input: {
  currency: string;
  lines: Array<{ variantId: string; quantity: number; unitPriceCents: number }>;
  shippingCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}): string {
  const canonical = [
    input.currency,
    ...[...input.lines]
      .map((line) => `${line.variantId}:${line.quantity}:${line.unitPriceCents}`)
      // Sorted, because a basket is a set: re-ordering the same items must not
      // invalidate a quote.
      .sort(),
    `ship:${input.shippingCents}`,
    `disc:${input.discountCents}`,
    `tax:${input.taxCents}`,
    `total:${input.totalCents}`,
  ].join('|');

  return fnv1a64(canonical);
}

/**
 * A short, stable hash.
 *
 * FNV-1a rather than SHA-256 because this is a change-detection tag, not a
 * security primitive, and it must produce the same value in every runtime that
 * computes it. Using a crypto hash here would invite the mistake of treating
 * the result as authenticated.
 */
function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

/** A configured shipping rate, as stored. */
export interface ShippingRateRule {
  code: string;
  name: string;
  description: string | null;
  countries: readonly string[];
  regions: readonly string[];
  priceCents: number;
  freeAboveSubtotalCents: number | null;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  minSubtotalCents: number | null;
  maxSubtotalCents: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}

export interface ShippingQuoteContext {
  country: string;
  region: string;
  subtotalCents: number;
  totalWeightGrams: number;
}

/**
 * Which configured rates apply, and at what price.
 *
 * Pure, and separate from the service that reads the rates, for the same reason
 * `priceOrder` is: a checkout quote, a re-quote at payment time and a
 * subscription renewal must agree on delivery cost to the cent, and they only
 * agree reliably if they run the same code. The caller supplies the rows; this
 * decides.
 *
 * Free-shipping thresholds are applied here rather than as a discount, so the
 * customer sees "Free" against the method instead of a line item that needs
 * explaining.
 */
export function quoteShippingRates(
  rates: readonly ShippingRateRule[],
  context: ShippingQuoteContext,
): ShippingQuote[] {
  const quotes: ShippingQuote[] = [];

  for (const rate of rates) {
    if (!rate.countries.includes(context.country)) continue;

    // An empty region list means the whole country; a non-empty one is an
    // allow-list of states.
    if (rate.regions.length > 0 && !rate.regions.includes(context.region)) continue;

    if (rate.minWeightGrams !== null && context.totalWeightGrams < rate.minWeightGrams) continue;
    if (rate.maxWeightGrams !== null && context.totalWeightGrams > rate.maxWeightGrams) continue;
    if (rate.minSubtotalCents !== null && context.subtotalCents < rate.minSubtotalCents) continue;
    if (rate.maxSubtotalCents !== null && context.subtotalCents > rate.maxSubtotalCents) continue;

    const free =
      rate.freeAboveSubtotalCents !== null && context.subtotalCents >= rate.freeAboveSubtotalCents;

    quotes.push({
      code: rate.code,
      name: rate.name,
      description: rate.description,
      priceCents: free ? 0 : rate.priceCents,
      estimatedDaysMin: rate.estimatedDaysMin,
      estimatedDaysMax: rate.estimatedDaysMax,
    });
  }

  return quotes;
}
