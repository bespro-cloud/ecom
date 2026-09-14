import type { MetadataRoute } from 'next';
import { fetchSitemapEntries } from '@/lib/catalogue';
import { apiRequest } from '@/lib/api-client';
import { publicConfig } from '@/lib/env';

/**
 * The sitemap is read from the database, not maintained by hand.
 *
 * Two consequences worth stating. A listing withdrawn from sale leaves the
 * sitemap on the next revalidation rather than sitting in it advertising a 404;
 * and anything an editor marked `noindex` is excluded at the source, so the
 * sitemap cannot contradict the page's own robots directive.
 *
 * Account and authentication routes are absent by design — listing them would
 * advertise them to crawlers and add nothing for a person.
 */

export const revalidate = 3600;

interface SitemapPage {
  slug: string;
  updatedAt: string;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = publicConfig.siteUrl;

  const [catalogue, pages] = await Promise.all([
    fetchSitemapEntries().catch(() => ({
      products: [],
      categories: [],
      pages: [],
      posts: [],
    })),
    apiRequest<{ pages: SitemapPage[] }>('/api/v1/content/sitemap', {
      forwardCookies: false,
      revalidate: 3600,
    })
      .then((response) => response.pages)
      // A failure here must not take the whole sitemap down: a partial sitemap
      // is far better than a 500 to a crawler.
      .catch(() => [] as SitemapPage[]),
  ]);

  return [
    { url: base, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    {
      url: `${base}/products`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    ...catalogue.categories.map((category) => ({
      url: `${base}/categories/${category.slug}`,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
    ...catalogue.products.map((product) => ({
      url: `${base}/products/${product.slug}`,
      lastModified: new Date(product.updatedAt),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...pages.map((page) => ({
      url: `${base}/pages/${page.slug}`,
      lastModified: new Date(page.updatedAt),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
    ...(catalogue.posts.length > 0
      ? [
          {
            url: `${base}/blog`,
            lastModified: new Date(),
            changeFrequency: 'weekly' as const,
            priority: 0.6,
          },
        ]
      : []),
    // Published posts only, and any marked noindex are excluded by the API
    // before they reach here — a sitemap must not contradict a page's own
    // robots directive.
    ...catalogue.posts.map((post) => ({
      url: `${base}/blog/${post.slug}`,
      lastModified: new Date(post.updatedAt),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];
}
