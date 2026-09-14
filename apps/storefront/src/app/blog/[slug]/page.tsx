import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@health/ui';
import { ApiError } from '@/lib/api-client';
import { fetchBlogPost, type BlogPostDetail } from '@/lib/lifecycle';
import { redirectOrNotFound } from '@/lib/redirects';
import { formatDate, formatMoney } from '@/lib/format';
import { PageBlocks } from '@/components/page-blocks';

async function load(slug: string): Promise<BlogPostDetail> {
  try {
    return await fetchBlogPost(slug);
  } catch (error) {
    // A renamed post keeps working: an article that has been shared and linked
    // to should not start 404ing because somebody tidied up a slug.
    if (error instanceof ApiError && error.status === 404) {
      await redirectOrNotFound(`/blog/${slug}`);
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
  const post = await load(slug);

  return {
    title: post.title,
    description: post.excerpt ?? undefined,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: 'article',
      title: post.title,
      description: post.excerpt ?? undefined,
      publishedTime: post.publishedAt ?? undefined,
      authors: [post.author],
      images: post.heroImage ? [{ url: post.heroImage.url, alt: post.heroImage.altText }] : [],
    },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await load(slug);

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      {post.category ? (
        <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
          {post.category.name}
        </p>
      ) : null}

      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{post.title}</h1>

      {/* The author is shown. An article about a health product with nobody's
          name on it is the kind of thing nobody stands behind. */}
      <p className="mt-3 text-sm text-slate-600">
        By {post.author}
        {post.publishedAt ? ` · ${formatDate(post.publishedAt)}` : ''}
      </p>

      {post.heroImage ? (
        <img
          src={post.heroImage.url}
          alt={post.heroImage.altText}
          width={post.heroImage.width ?? undefined}
          height={post.heroImage.height ?? undefined}
          className="mt-6 w-full rounded-xl"
        />
      ) : null}

      <div className="mt-8">
        <PageBlocks blocks={post.blocks as never} />
      </div>

      {post.products.length > 0 ? (
        <section aria-labelledby="mentioned-heading" className="mt-12">
          <h2 id="mentioned-heading" className="text-lg font-semibold text-slate-900">
            Products mentioned
          </h2>
          <ul className="mt-4 space-y-3">
            {post.products.map((product) => (
              <li key={product.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Link
                      href={`/products/${product.slug}`}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {product.name}
                    </Link>
                    <span className="tabular-nums text-slate-900">
                      {formatMoney(product.priceCents)}
                    </span>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Required on any page that discusses a supplement, and stated in the
          same words as the product pages rather than a softer paraphrase. */}
      <p className="mt-12 rounded-xl bg-white p-5 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200">
        These statements have not been evaluated by the Food and Drug Administration. This product
        is not intended to diagnose, treat, cure or prevent any disease. This article is general
        information, not medical advice — talk to your doctor or pharmacist about your own health.
      </p>

      <p className="mt-6 text-sm">
        <Link href="/blog" className="text-brand-700 hover:text-brand-800">
          Back to the journal
        </Link>
      </p>
    </article>
  );
}
