import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { fetchMyReviews } from '@/lib/lifecycle';
import { formatDate } from '@/lib/format';
import { StarRating } from '@/components/star-rating';

export const metadata: Metadata = { title: 'Your reviews', robots: { index: false } };

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  PUBLISHED: 'success',
  PENDING: 'warning',
  ESCALATED: 'warning',
  REJECTED: 'danger',
  REMOVED: 'neutral',
};

const LABEL: Record<string, string> = {
  PUBLISHED: 'Published',
  PENDING: 'Being read',
  ESCALATED: 'With our compliance team',
  REJECTED: 'Not published',
  REMOVED: 'Removed',
};

/**
 * The customer's own reviews, published or not.
 *
 * The status sentence shown against each one is the API's `visibility` string,
 * not a phrase composed here. There is one place that decides what a review's
 * state means to the person who wrote it, and it is the same place that owns
 * the state machine.
 */
export default async function MyReviewsPage() {
  const reviews = await fetchMyReviews();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your reviews"
        description="Everything you have written, including reviews still waiting to be read."
      />

      {reviews.length === 0 ? (
        <EmptyState
          title="You have not written a review yet"
          description="You can review any product from its page."
          action={
            <Link href="/products" className="text-sm font-medium text-brand-700">
              Browse products
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {reviews.map((review) => (
            <li key={review.id}>
              <Card>
                <div className="flex flex-wrap items-center gap-3">
                  <StarRating value={review.rating} label={`${review.rating} out of 5`} size="sm" />
                  <span className="text-sm font-medium text-slate-900">{review.rating} / 5</span>
                  <Badge tone={TONE[review.status] ?? 'neutral'}>
                    {LABEL[review.status] ?? review.status}
                  </Badge>
                  {review.verifiedPurchase ? <Badge tone="info">Verified purchase</Badge> : null}
                  <span className="text-sm text-slate-500">{formatDate(review.createdAt)}</span>
                </div>

                {review.product ? (
                  <p className="mt-2 text-sm text-slate-600">
                    <Link
                      href={`/products/${review.product.slug}`}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {review.product.name}
                    </Link>
                  </p>
                ) : null}

                {review.title ? (
                  <h2 className="mt-2 text-base font-semibold text-slate-900">{review.title}</h2>
                ) : null}

                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                  {review.body}
                </p>

                <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  {review.visibility}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
