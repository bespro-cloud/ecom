import type { ProductDetail } from '@/lib/catalogue';
import { buildBreadcrumbJsonLd, buildProductJsonLd, serialiseJsonLd } from '@/lib/structured-data';

/**
 * Schema.org markup.
 *
 * The payloads and the escaping live in `@/lib/structured-data`, where they are
 * tested — what a search result asserts about a healthcare product is not
 * something to leave to an untested string template.
 */

export function ProductStructuredData({ product, url }: { product: ProductDetail; url: string }) {
  return <JsonLd data={buildProductJsonLd(product, url)} />;
}

export function BreadcrumbStructuredData({
  trail,
  siteUrl,
}: {
  trail: Array<{ name: string; path: string }>;
  siteUrl: string;
}) {
  return <JsonLd data={buildBreadcrumbJsonLd(trail, siteUrl)} />;
}

function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // Safe here, and only here: the payload is JSON this app serialised
      // itself, with every character that could close the script element
      // already escaped by `serialiseJsonLd`.
      dangerouslySetInnerHTML={{ __html: serialiseJsonLd(data) }}
    />
  );
}
