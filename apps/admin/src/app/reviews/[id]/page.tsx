import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { getReview, humanise } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { ReviewModerationForm } from '@/components/review-moderation-form';

export const metadata: Metadata = { title: 'Review' };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'REVIEW_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="REVIEW_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;
  const review = await getReview(id);
  const decided = review.status !== 'PENDING';

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={review.title ?? 'Review'}
          description={`${review.rating} out of 5 for ${review.product?.name ?? 'a product'}`}
          actions={<Badge tone="neutral">{humanise(review.status)}</Badge>}
        />

        {review.adverseEventPromptTerms.length > 0 ? (
          <Alert tone="error" title="This review may describe harm">
            <p>
              The wording matched: {review.adverseEventPromptTerms.join(', ')}. Read it carefully.
              If the customer experienced harm, flag it below — that record is kept whether or not
              you publish the review, and this system does not report anything on your behalf.
            </p>
          </Alert>
        ) : null}

        {review.claimPromptTerms.length > 0 ? (
          <Alert tone="warning" title="Wording worth a second look">
            <p>
              Matched: {review.claimPromptTerms.join(', ')}. This is a prompt for you, not a
              finding. Nothing has been decided, and nothing will be until you decide it.
            </p>
          </Alert>
        ) : null}

        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-slate-900">{review.rating} / 5</span>
            {review.verifiedPurchase ? <Badge tone="success">Verified purchase</Badge> : null}
            <span className="text-sm text-slate-500">{formatDateTime(review.createdAt)}</span>
          </div>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-800">
            {review.body}
          </p>
          <dl className="mt-4 grid gap-3 border-t border-slate-200 pt-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Shown as</dt>
              <dd className="mt-0.5 text-slate-900">{review.authorDisplayName}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Customer</dt>
              <dd className="mt-0.5 font-mono text-slate-900">{review.customer.reference}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Product</dt>
              <dd className="mt-0.5 text-slate-900">{review.product?.name ?? '—'}</dd>
            </div>
          </dl>
        </Card>

        {hasPermission(user, 'REVIEW_MODERATE') ? (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">
              {decided ? 'Change this decision' : 'Decide'}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Your reasoning is recorded permanently against the review.
            </p>
            <div className="mt-4">
              <ReviewModerationForm
                reviewId={review.id}
                suggestAdverseEvent={review.adverseEventFlaggedAt !== null}
              />
            </div>
          </Card>
        ) : (
          <Alert tone="info" title="You can read this but not decide it">
            <p>Moderating a review needs the REVIEW_MODERATE permission.</p>
          </Alert>
        )}

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Decision history</h2>
          {review.decisions.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">No decision has been recorded yet.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {review.decisions.map((decision) => (
                <li key={decision.id} className="border-l-2 border-slate-200 pl-4">
                  <p className="text-sm font-medium text-slate-900">
                    {humanise(decision.fromStatus)} → {humanise(decision.toStatus)}
                    {decision.reason ? ` · ${humanise(decision.reason)}` : ''}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
                    {decision.notes}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {decision.moderatorLabel} · {formatDateTime(decision.decidedAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <p className="text-sm">
          <Link href="/reviews" className="text-brand-700 hover:text-brand-800">
            Back to the queue
          </Link>
        </p>
      </div>
    </ConsoleShell>
  );
}
