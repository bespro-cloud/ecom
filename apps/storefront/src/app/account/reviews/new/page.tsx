import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@health/ui';
import { ApiError } from '@/lib/api-client';
import { fetchProduct } from '@/lib/catalogue';
import { fetchOrders } from '@/lib/commerce';
import { currentUser } from '@/lib/session';
import { WriteReviewForm, type PurchaseOption } from '@/components/write-review-form';

export const metadata: Metadata = { title: 'Write a review', robots: { index: false } };

/**
 * The write-a-review screen.
 *
 * The purchase list is built from the customer's *own* orders, read with their
 * session. It is a convenience, not the check — the API re-derives the verified
 * badge from the order line and refuses one that is not theirs, so a crafted
 * request gets a refusal rather than a badge.
 */
export default async function WriteReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const { product: slug } = await searchParams;
  if (!slug) notFound();

  const user = await currentUser();
  if (!user) {
    // The middleware normally catches this; this is the render-time race.
    notFound();
  }

  let product;
  try {
    product = await fetchProduct(slug);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const orders = await fetchOrders();
  const purchases: PurchaseOption[] = orders.flatMap((order) =>
    order.items
      .filter((item) => item.productId === product.id)
      .map((item) => ({
        orderItemId: item.id,
        orderReference: order.reference,
        variantName: item.variantName,
        placedAt: order.placedAt,
      })),
  );

  const defaultDisplayName =
    [user.firstName, user.lastName?.slice(0, 1)].filter(Boolean).join(' ').trim() || 'A customer';

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Review ${product.name}`}
        description="Your review is read by our team before it appears on the product page."
      />

      {purchases.length === 0 ? (
        <Alert tone="info" title="We have no record of you buying this">
          <p>
            You can still write a review — it just will not carry a “verified purchase” badge. That
            badge only ever comes from an order on your own account.
          </p>
        </Alert>
      ) : null}

      <Card>
        <WriteReviewForm
          productId={product.id}
          productName={product.name}
          purchases={purchases}
          defaultDisplayName={defaultDisplayName}
        />
      </Card>

      <p className="text-sm text-slate-600">
        <Link href={`/products/${product.slug}`} className="text-brand-700 hover:text-brand-800">
          Back to {product.name}
        </Link>
      </p>
    </div>
  );
}
