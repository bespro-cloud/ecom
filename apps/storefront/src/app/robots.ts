import type { MetadataRoute } from 'next';
import { publicConfig } from '@/lib/env';

/**
 * The catalogue is not published yet (Phase 2), and account pages must never be
 * indexed at all. Crawling is therefore disallowed wholesale for now; this
 * becomes a selective policy when there is a catalogue to index.
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
            ],
          },
        ]
      : [{ userAgent: '*', disallow: '/' }],
    sitemap: `${publicConfig.siteUrl}/sitemap.xml`,
  };
}
