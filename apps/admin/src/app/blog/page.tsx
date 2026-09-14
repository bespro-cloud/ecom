import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { humanise, listBlogPosts } from '@/lib/growth';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Journal' };

const TONE: Record<string, 'success' | 'warning' | 'neutral' | 'info'> = {
  PUBLISHED: 'success',
  IN_REVIEW: 'warning',
  DRAFT: 'neutral',
  ARCHIVED: 'neutral',
};

export default async function BlogPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'BLOG_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="BLOG_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listBlogPosts('limit=100');
  const awaitingReview = data.filter((post) => post.status === 'IN_REVIEW');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Journal"
          description="An article that names a product is marketing copy about a regulated product. Those go to compliance before they can be published; articles that name no product do not."
          actions={
            hasPermission(user, 'BLOG_WRITE') ? (
              <Link
                href="/blog/new"
                className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                New post
              </Link>
            ) : null
          }
        />

        {awaitingReview.length > 0 ? (
          <Alert tone="warning" title={`${awaitingReview.length} post(s) waiting for compliance`}>
            Each one names a product and cannot be published until a compliance reviewer reads the
            text and records a decision.
          </Alert>
        ) : null}

        <Card>
          {data.length === 0 ? (
            <EmptyState title="No posts yet" description="Write one to get started." />
          ) : (
            <TableShell caption="Posts, most recently edited first">
              <thead>
                <tr>
                  <Th>Title</Th>
                  <Th>Author</Th>
                  <Th>Status</Th>
                  <Th>Compliance</Th>
                  <Th>Updated</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((post) => (
                  <tr key={post.id}>
                    <Td>
                      <Link
                        href={`/blog/${post.id}`}
                        className="text-sm font-medium text-slate-900 hover:underline"
                      >
                        {post.title}
                      </Link>
                      <span className="block font-mono text-xs text-slate-500">/{post.slug}</span>
                    </Td>
                    <Td className="text-sm">{post.author}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={TONE[post.status] ?? 'neutral'}>{humanise(post.status)}</Badge>
                        {post.hasUnpublishedChanges ? (
                          <Badge tone="info">Unpublished edits</Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td>
                      {!post.needsCompliance ? (
                        <span className="text-sm text-slate-500">Not required</span>
                      ) : post.hasComplianceApproval ? (
                        <span className="text-sm text-slate-700">
                          Approved by {post.complianceApprovedBy}
                        </span>
                      ) : (
                        <Badge tone="warning">Needs sign-off</Badge>
                      )}
                    </Td>
                    <Td className="text-sm">{formatDate(post.updatedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}
