import type { MetadataRoute } from 'next';
import { publicConfig } from '@/lib/env';

/**
 * Crawling policy.
 *
 * Account, authentication and proxy routes are never indexable — they are
 * per-user or per-session and listing them would advertise them for nothing.
 * The catalogue is, which is what `sitemap.xml` enumerates from the database.
 *
 * Indexing stays off entirely unless `NEXT_PUBLIC_ALLOW_INDEXING` is set, so a
 * staging deployment cannot quietly end up in search results.
 */
export default function robots(): MetadataRoute.Robots {
  const indexable = process.env.NEXT_PUBLIC_ALLOW_INDEXING === 'true';

  return {
    rules: indexable
      ? [
          {
            userAgent: '*',
            allow: '/',
            disallow: [
              '/account/',
              '/api/',
              '/login',
              '/register',
              '/reset-password',
              '/verify-email',
              // A search results page is a view of the catalogue, not a page
              // worth indexing in its own right; the product pages it links to
              // are the canonical destinations.
              '/products?*',
            ],
          },
        ]
      : [{ userAgent: '*', disallow: '/' }],
    sitemap: `${publicConfig.siteUrl}/sitemap.xml`,
  };
}
