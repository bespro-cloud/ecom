import { describe, expect, it } from 'vitest';
import type { ProductDetail } from './catalogue';
import { buildBreadcrumbJsonLd, buildProductJsonLd, serialiseJsonLd } from './structured-data';

function product(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: 'p1',
    sku: 'HC-MAG-GLY-120',
    slug: 'magnesium-glycinate-120-capsules',
    name: 'Magnesium Glycinate, 120 capsules',
    shortDescription: '200 mg elemental magnesium per serving.',
    longDescription: null,
    type: 'SUPPLEMENT',
    typeLabel: 'Supplement',
    brand: 'Health Commerce',
    manufacturer: 'Example Manufacturing LLC',
    countryOfOrigin: 'US',
    priceCents: 2400,
    compareAtPriceCents: 2900,
    currency: 'USD',
    requiresShipping: true,
    subscriptionEligible: false,
    weightGrams: 150,
    publishedAt: '2026-09-11T00:00:00.000Z',
    availableQuantity: 12,
    images: [],
    variants: [],
    categories: [],
    breadcrumbs: [],
    ingredients: [],
    warnings: [],
    allergens: [],
    claims: [],
    disclaimers: [],
    seo: {
      title: 'Magnesium Glycinate',
      description: null,
      canonicalUrl: null,
      ogTitle: null,
      ogDescription: null,
      noindex: false,
    },
    ...overrides,
  };
}

const URL = 'https://example.test/products/magnesium-glycinate-120-capsules';

describe('buildProductJsonLd', () => {
  it('asserts nothing the catalogue does not hold', () => {
    // Every one of these would be a fabricated fact presented to a search
    // engine as structured data about a healthcare product.
    const payload = buildProductJsonLd(product(), URL);

    expect(payload).not.toHaveProperty('aggregateRating');
    expect(payload).not.toHaveProperty('review');
    expect(payload).not.toHaveProperty('gtin');
    expect(payload).not.toHaveProperty('gtin13');
    expect(payload).not.toHaveProperty('mpn');
    expect(payload.offers).not.toHaveProperty('availability');
  });

  it('formats the price from integer minor units', () => {
    const payload = buildProductJsonLd(product({ priceCents: 2400 }), URL);
    expect((payload.offers as { price: string }).price).toBe('24.00');
  });

  it('does not lose a cent to floating point', () => {
    // 1999 / 100 is not exact in binary; the assertion is that the rendered
    // string is still the price on the listing.
    expect(
      (buildProductJsonLd(product({ priceCents: 1999 }), URL).offers as { price: string }).price,
    ).toBe('19.99');
    expect(
      (buildProductJsonLd(product({ priceCents: 70 }), URL).offers as { price: string }).price,
    ).toBe('0.70');
  });

  it('omits optional fields rather than emitting empty ones', () => {
    const payload = buildProductJsonLd(
      product({ brand: null, manufacturer: null, countryOfOrigin: null, shortDescription: null }),
      URL,
    );

    expect(payload).not.toHaveProperty('brand');
    expect(payload).not.toHaveProperty('manufacturer');
    expect(payload).not.toHaveProperty('countryOfOrigin');
    expect(payload).not.toHaveProperty('description');
  });

  it('uses the listing’s own description, never a synthesised one', () => {
    const payload = buildProductJsonLd(
      product({ shortDescription: 'Contains 200 mg elemental magnesium.' }),
      URL,
    );
    expect(payload.description).toBe('Contains 200 mg elemental magnesium.');
  });
});

describe('buildBreadcrumbJsonLd', () => {
  it('numbers positions from one and makes item URLs absolute', () => {
    const payload = buildBreadcrumbJsonLd(
      [
        { name: 'Products', path: '/products' },
        { name: 'Minerals', path: '/categories/minerals' },
      ],
      'https://example.test',
    );

    expect(payload.itemListElement).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Products',
        item: 'https://example.test/products',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Minerals',
        item: 'https://example.test/categories/minerals',
      },
    ]);
  });
});

describe('serialiseJsonLd', () => {
  it('escapes the characters that could close the script element', () => {
    // A product name is editor-supplied. Without this, "</script>" in a name
    // ends the element and the rest of the payload becomes markup.
    const output = serialiseJsonLd({ name: '</script><img src=x onerror=alert(1)>' });

    expect(output).not.toContain('</script>');
    expect(output).not.toContain('<');
    expect(output).not.toContain('>');
    expect(output).toContain('\\u003c');
  });

  it('escapes ampersands', () => {
    expect(serialiseJsonLd({ name: 'A & B' })).toContain('\\u0026');
  });

  it('escapes the JavaScript line separators', () => {
    // U+2028 and U+2029 terminate a line in JavaScript but not in JSON, so an
    // unescaped one inside an inline script is a syntax error at best.
    const output = serialiseJsonLd({ name: 'a\u2028b\u2029c' });
    expect(output).not.toContain('\u2028');
    expect(output).not.toContain('\u2029');
    expect(output).toContain('\\u2028');
  });

  it('still parses back to the original value', () => {
    const value = { name: 'Magnesium & <Glycinate>', price: '24.00' };
    expect(JSON.parse(serialiseJsonLd(value))).toEqual(value);
  });
});
