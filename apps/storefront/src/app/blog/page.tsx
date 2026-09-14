import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@health/ui';
import { fetchBlogPosts } from '@/lib/lifecycle';
import { formatDate } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Journal',
  description:
    'What we have read, what the evidence does and does not show, and how we decide what to stock.',
};

export default async function BlogIndexPage() {
  const posts = await fetchBlogPosts(30);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <PageHeader
        title="Journal"
        description="Written by our team and, where an article discusses a product we sell, read by our compliance reviewers before it is published."
      />

      {posts.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="Nothing published yet" description="Articles will appear here." />
        </div>
      ) : (
        <ul className="mt-8 space-y-4">
          {posts.map((post) => (
            <li key={post.id}>
              <Link href={`/blog/${post.slug}`} className="block">
                <Card className="transition-colors hover:bg-slate-50">
                  {post.category ? (
                    <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
                      {post.category.name}
                    </p>
                  ) : null}
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">{post.title}</h2>
                  {post.excerpt ? (
                    <p className="mt-2 text-sm leading-relaxed text-slate-700">{post.excerpt}</p>
                  ) : null}
                  <p className="mt-3 text-sm text-slate-500">
                    {post.author}
                    {post.publishedAt ? ` · ${formatDate(post.publishedAt)}` : ''}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
