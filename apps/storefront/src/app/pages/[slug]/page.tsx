import type { Metadata } from 'next';
import { redirectOrNotFound } from '@/lib/redirects';
import { ApiError, apiRequest } from '@/lib/api-client';
import { PageBlocks, type Block } from '@/components/page-blocks';

/**
 * A CMS page.
 *
 * Reads the *published* endpoint, which by construction cannot return draft
 * content: there is no parameter on it that would widen the query. An editor
 * saving a half-finished edit to the shipping policy therefore cannot change
 * the shipping policy a customer is reading.
 */

interface PublishedPage {
  slug: string;
  title: string;
  blocks: Block[];
  publishedAt: string | null;
  seo: {
    title: string;
    description: string | null;
    canonicalUrl: string | null;
    noindex: boolean;
  };
}

async function load(slug: string): Promise<PublishedPage> {
  try {
    return await apiRequest<PublishedPage>(`/api/v1/content/pages/${encodeURIComponent(slug)}`, {
      forwardCookies: false,
      revalidate: 60,
    });
  } catch (error) {
    // A renamed page keeps working: policy pages are exactly the ones somebody
    // linked to from an email two years ago.
    if (error instanceof ApiError && error.status === 404) {
      await redirectOrNotFound(`/pages/${slug}`);
    }
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await load(slug);

  return {
    title: page.seo.title,
    description: page.seo.description ?? undefined,
    alternates: { canonical: page.seo.canonicalUrl ?? `/pages/${page.slug}` },
    robots: page.seo.noindex ? { index: false, follow: true } : undefined,
  };
}

export default async function ContentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await load(slug);

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 text-slate-700 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{page.title}</h1>
      <div className="mt-6">
        <PageBlocks blocks={page.blocks} />
      </div>
    </article>
  );
}
