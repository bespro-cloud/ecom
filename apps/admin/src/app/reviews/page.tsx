import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { humanise, listReviews } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Review moderation' };

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  PUBLISHED: 'success',
  PENDING: 'warning',
  ESCALATED: 'warning',
  REJECTED: 'danger',
  REMOVED: 'neutral',
};

/**
 * The moderation queue.
 *
 * Oldest first, because a review waiting three weeks is the problem, not the
 * one written this morning.
 *
 * Matched wording is shown as a prompt and nothing more. No review is
 * auto-rejected, auto-published or auto-sorted on the strength of it: a word
 * list cannot tell whether "it cured my headache" is a disease claim in
 * context, and code that acted on one would be making a regulatory decision by
 * substring match.
 */
export default async function ReviewsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'REVIEW_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="REVIEW_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listReviews('limit=100');
  const waiting = data.filter((review) => review.status === 'PENDING');
  const prompted = waiting.filter((review) => review.claimPromptTerms.length > 0);
  const adverse = data.filter((review) => review.adverseEventFlaggedAt !== null);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Review moderation"
          description="Every review is read before it appears. Nothing on this page publishes itself, and no review is rejected automatically."
        />

        {adverse.length > 0 ? (
          <Alert
            tone="error"
            title={`${adverse.length} review(s) flagged as a possible adverse event`}
          >
            A customer describing harm is a safety signal. Make sure each one has been passed to
            whoever handles adverse-event reporting — this system does not report anything on your
            behalf.
          </Alert>
        ) : null}

        {prompted.length > 0 ? (
          <Alert
            tone="warning"
            title={`${prompted.length} waiting review(s) use wording worth a second look`}
          >
            The wording matched a phrase that often signals a health claim. That is a prompt, not a
            finding: read it and decide.
          </Alert>
        ) : null}

        <Card>
          {data.length === 0 ? (
            <EmptyState
              title="Nothing to moderate"
              description="Reviews appear here as customers write them."
            />
          ) : (
            <TableShell caption="Reviews, oldest first">
              <thead>
                <tr>
                  <Th>Written</Th>
                  <Th>Product</Th>
                  <Th className="text-right">Rating</Th>
                  <Th>Review</Th>
                  <Th>Status</Th>
                  <Th>Prompts</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((review) => (
                  <tr key={review.id}>
                    <Td>{formatDate(review.createdAt)}</Td>
                    <Td>
                      <span className="text-sm text-slate-900">{review.product?.name ?? '—'}</span>
                      <span className="block font-mono text-xs text-slate-500">
                        {review.product?.sku ?? ''}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">{review.rating} / 5</Td>
                    <Td>
                      <Link
                        href={`/reviews/${review.id}`}
                        className="text-sm font-medium text-slate-900 hover:underline"
                      >
                        {review.title ?? `${review.body.slice(0, 60)}…`}
                      </Link>
                      <span className="block text-xs text-slate-500">
                        {review.authorDisplayName}
                        {review.verifiedPurchase ? ' · verified purchase' : ''}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={TONE[review.status] ?? 'neutral'}>
                        {humanise(review.status)}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {review.adverseEventFlaggedAt ? (
                          <Badge tone="danger">Adverse event</Badge>
                        ) : null}
                        {review.claimPromptTerms.length > 0 ? (
                          <Badge tone="warning">
                            {review.claimPromptTerms.length} claim phrase(s)
                          </Badge>
                        ) : null}
                      </div>
                    </Td>
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
