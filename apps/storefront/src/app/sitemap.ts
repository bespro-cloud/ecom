import type { MetadataRoute } from 'next';
import { publicConfig } from '@/lib/env';

/**
 * Only publicly meaningful, indexable pages belong here. Account and
 * authentication routes are excluded by design — listing them would advertise
 * them to crawlers and add nothing for a person.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: publicConfig.siteUrl,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
