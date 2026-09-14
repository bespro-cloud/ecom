import Link from 'next/link';
import { Badge, Card, EmptyState } from '@health/ui';
import type { ProductReviews } from '@/lib/lifecycle';
import { formatDate } from '@/lib/format';
import { StarRating } from './star-rating';

/**
 * Published reviews on a listing.
 *
 * Everything here has been read by a moderator — the API returns nothing else,
 * and the average is computed over the same set, so unmoderated wording cannot
 * move the number even while its words stay hidden.
 *
 * The "verified purchase" badge is the API's, derived from the reviewer's own
 * order line. Nothing on this page decides it.
 */
export function ProductReviews({
  slug,
  data,
  canWrite,
}: {
  slug: string;
  data: ProductReviews;
  canWrite: boolean;
}) {
  const { reviews, summary } = data;

  return (
    <section aria-labelledby="reviews-heading" className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="reviews-heading" className="text-xl font-semibold text-slate-900">
            Customer reviews
          </h2>
          {summary.average === null ? (
            <p className="mt-1 text-sm text-slate-600">No reviews yet.</p>
          ) : (
            <p className="mt-1 flex items-center gap-2 text-sm text-slate-600">
              <StarRating
                value={summary.average}
                label={`${summary.average} out of 5, from ${summary.count} ${
                  summary.count === 1 ? 'review' : 'reviews'
                }`}
              />
              <span>
                <span className="font-medium text-slate-900">{summary.average}</span> out of 5 ·{' '}
                {summary.count} {summary.count === 1 ? 'review' : 'reviews'}
              </span>
            </p>
          )}
        </div>

        <Link
          href={
            canWrite
              ? `/account/reviews/new?product=${encodeURIComponent(slug)}`
              : `/login?next=${encodeURIComponent(`/account/reviews/new?product=${slug}`)}`
          }
          className="text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          Write a review
        </Link>
      </div>

      <p className="mt-2 max-w-prose text-sm text-slate-500">
        Reviews are the opinions of individual customers. They are not medical advice, and a
        product&rsquo;s effect varies from person to person. Every review is read by our team before
        it appears.
      </p>

      {reviews.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Nothing published yet"
            description="Reviews appear here once a customer has written one and our team has read it."
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {reviews.map((review) => (
            <li key={review.id}>
              <Card>
                <div className="flex flex-wrap items-center gap-3">
                  <StarRating value={review.rating} label={`${review.rating} out of 5`} size="sm" />
                  <span className="text-sm font-medium text-slate-900">{review.rating} / 5</span>
                  {review.verifiedPurchase ? <Badge tone="success">Verified purchase</Badge> : null}
                  {review.publishedAt ? (
                    <span className="text-sm text-slate-500">{formatDate(review.publishedAt)}</span>
                  ) : null}
                </div>

                {review.title ? (
                  <h3 className="mt-2 text-base font-semibold text-slate-900">{review.title}</h3>
                ) : null}

                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                  {review.body}
                </p>

                <p className="mt-3 text-sm text-slate-500">
                  {review.authorDisplayName ?? 'A customer'}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
