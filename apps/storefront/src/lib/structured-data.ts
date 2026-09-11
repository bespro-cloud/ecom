import type { ProductDetail } from './catalogue';

/**
 * Schema.org payloads.
 *
 * The governing rule is that this markup must not assert anything the catalogue
 * does not actually hold, because a search result is read by people who cannot
 * see the listing behind it. Specifically:
 *
 *  - **No `aggregateRating` or `review`.** There is no review system, and
 *    emitting rating markup without ratings is both a Google policy violation
 *    and a straightforward lie.
 *  - **No `gtin` or `mpn` unless recorded.** A guessed identifier is worse than
 *    an absent one: it can match somebody else's product.
 *  - **No `availability`.** Inventory arrives in Phase 3. A hardcoded
 *    `InStock` would be a fabricated fact about a real order.
 *  - **No health claims.** The description is the listing's own short
 *    description, which the compliance review covered. Nothing is synthesised.
 */

export function buildProductJsonLd(product: ProductDetail, url: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    sku: product.sku,
    url,
    ...(product.shortDescription ? { description: product.shortDescription } : {}),
    ...(product.brand ? { brand: { '@type': 'Brand', name: product.brand } } : {}),
    ...(product.manufacturer
      ? { manufacturer: { '@type': 'Organization', name: product.manufacturer } }
      : {}),
    ...(product.countryOfOrigin ? { countryOfOrigin: product.countryOfOrigin } : {}),
    ...(product.images.length > 0 ? { image: product.images.map((image) => image.url) } : {}),
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: product.currency,
      // Schema.org wants a decimal string. The value is derived from integer
      // minor units, never from a float that has been through arithmetic.
      price: (product.priceCents / 100).toFixed(2),
    },
  };
}

export function buildBreadcrumbJsonLd(
  trail: Array<{ name: string; path: string }>,
  siteUrl: string,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: `${siteUrl}${entry.path}`,
    })),
  };
}

/**
 * Serialises a payload for embedding in a `<script>` element.
 *
 * `JSON.stringify` escapes nothing that matters inside a script element, so the
 * characters that could close it — or open an HTML comment — are escaped here.
 * A product name containing `</script>` would otherwise end the element and
 * turn the rest of the payload into markup.
 */
export function serialiseJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
