import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { getBlogPost, humanise } from '@/lib/growth';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { BlogPostActions } from '@/components/blog-post-actions';

export const metadata: Metadata = { title: 'Post' };

export default async function BlogPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'BLOG_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="BLOG_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;
  const post = await getBlogPost(id);
  const current = post.draft ?? { title: post.title, excerpt: post.excerpt, blocks: post.blocks };

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={current.title}
          description={`By ${post.author} · /blog/${post.slug}`}
          actions={<Badge tone="neutral">{humanise(post.status)}</Badge>}
        />

        {post.claimPromptTerms.length > 0 ? (
          <Alert tone="warning" title="Wording worth a second look">
            <p>
              Matched: {post.claimPromptTerms.join(', ')}. This is a prompt for whoever reads the
              article, not a finding. Nothing has been decided and nothing will be until a person
              decides it — a word list cannot tell whether a phrase is a disease claim in context.
            </p>
          </Alert>
        ) : null}

        {post.needsCompliance ? (
          <Alert tone="info" title="This post names a product">
            <p>
              That makes it marketing copy about a regulated product, so it goes through the same
              sign-off a listing does. Products named:{' '}
              {post.products.map((product) => product.name).join(', ') || '—'}
            </p>
          </Alert>
        ) : null}

        {post.hasUnpublishedChanges ? (
          <Alert tone="info" title="There are unpublished edits">
            <p>
              Readers are still seeing the published version. The draft below is what will go live
              when somebody publishes it.
            </p>
          </Alert>
        ) : null}

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">
            {post.draft ? 'Draft' : 'Published text'}
          </h2>
          {current.excerpt ? (
            <p className="mt-2 text-sm italic text-slate-600">{current.excerpt}</p>
          ) : null}
          <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">
            {blockText(current.blocks)}
          </pre>
        </Card>

        <Card>
          <BlogPostActions
            postId={post.id}
            status={post.status}
            needsCompliance={post.needsCompliance}
            publishable={post.publishable}
            approvalMatchesCurrentText={post.approvalMatchesCurrentText}
            hasApproval={post.hasComplianceApproval}
            canWrite={hasPermission(user, 'BLOG_WRITE')}
            canPublish={hasPermission(user, 'BLOG_PUBLISH')}
            canApprove={hasPermission(user, 'COMPLIANCE_APPROVE')}
            mfaEnabled={user.mfaEnabled}
          />
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Compliance history</h2>
          {post.reviews.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">No decision has been recorded yet.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {post.reviews.map((review) => (
                <li key={review.id} className="border-l-2 border-slate-200 pl-4">
                  <p className="text-sm font-medium text-slate-900">
                    {humanise(review.decision)} — &ldquo;{review.reviewedTitle}&rdquo;
                  </p>
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{review.notes}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {review.reviewerLabel} · {formatDateTime(review.decidedAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-4 text-sm text-slate-500">
            Each decision records the text that was read. Decisions are append-only — a database
            trigger refuses to let one be edited or removed.
          </p>
        </Card>

        <p className="text-sm">
          <Link href="/blog" className="text-brand-700 hover:text-brand-800">
            Back to the journal
          </Link>
        </p>
      </div>
    </ConsoleShell>
  );
}

/** The readable text of a block array, for review on this screen. */
function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => {
      const value = block as { type?: string; markdown?: string; text?: string };
      return value.markdown ?? value.text ?? '';
    })
    .filter(Boolean)
    .join('\n\n');
}
