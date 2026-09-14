import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { fetchMyPaymentMethods, fetchMySubscriptions } from '@/lib/lifecycle';
import { formatDate, formatMoney } from '@/lib/format';
import { SubscriptionControls } from '@/components/subscription-controls';

export const metadata: Metadata = { title: 'Your subscriptions', robots: { index: false } };

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  ACTIVE: 'success',
  PENDING: 'info',
  PAUSED: 'neutral',
  PAST_DUE: 'warning',
  UNPAID: 'danger',
  CANCELLED: 'neutral',
};

const LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  PENDING: 'Starting',
  PAUSED: 'Paused',
  PAST_DUE: 'Payment problem',
  UNPAID: 'Stopped — unpaid',
  CANCELLED: 'Cancelled',
};

function cadence(interval: string, count: number): string {
  const unit = interval === 'WEEK' ? 'week' : 'month';
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/**
 * Subscription management.
 *
 * Two things this page is careful about.
 *
 * A failed renewal is stated plainly, with what happens next, because
 * `PAST_DUE` means nothing is shipping — a customer who thinks a delivery is on
 * its way will not act, and it will not arrive.
 *
 * The price shown is the goods total the customer agreed to. Delivery and tax
 * are computed at each renewal and are not invented here; saying "total" over a
 * number that excludes them would be a lie in small type.
 */
export default async function SubscriptionsPage() {
  const [subscriptions, paymentMethods] = await Promise.all([
    fetchMySubscriptions(),
    fetchMyPaymentMethods(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your subscriptions"
        description="Repeat deliveries, what they cost and when the next one is."
      />

      {subscriptions.length === 0 ? (
        <EmptyState
          title="You have no subscriptions"
          description="Products available on repeat delivery say so on their page."
          action={
            <Link href="/products" className="text-sm font-medium text-brand-700">
              Browse products
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {subscriptions.map((subscription) => (
            <li key={subscription.id}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge tone={TONE[subscription.status] ?? 'neutral'}>
                      {LABEL[subscription.status] ?? subscription.status}
                    </Badge>
                    <span className="font-mono text-sm text-slate-500">
                      {subscription.reference}
                    </span>
                  </div>
                  <span className="text-sm text-slate-600">
                    {cadence(subscription.interval, subscription.intervalCount)}
                  </span>
                </div>

                {subscription.status === 'PAST_DUE' ? (
                  <div className="mt-3">
                    <Alert tone="warning" title="We could not take the last payment">
                      <p>
                        Nothing will be dispatched until it goes through. We will try again
                        {subscription.nextBillingAt
                          ? ` on ${formatDate(subscription.nextBillingAt)}`
                          : ' shortly'}
                        . Updating the card below is usually enough.
                      </p>
                    </Alert>
                  </div>
                ) : null}

                {subscription.status === 'UNPAID' ? (
                  <div className="mt-3">
                    <Alert tone="error" title="This subscription has stopped">
                      <p>
                        We tried the card several times and it did not go through, so we have
                        stopped trying rather than keep charging it. Nothing has been dispatched and
                        you have not been charged for it. Start a new subscription when you are
                        ready.
                      </p>
                    </Alert>
                  </div>
                ) : null}

                <ul className="mt-4 space-y-2">
                  {subscription.items.map((item) => (
                    <li key={item.id} className="flex flex-wrap justify-between gap-2 text-sm">
                      <span className="text-slate-900">
                        <Link
                          href={`/products/${item.productSlug}`}
                          className="font-medium text-brand-700 hover:text-brand-800"
                        >
                          {item.productName}
                        </Link>
                        {item.variantName ? (
                          <span className="text-slate-600"> — {item.variantName}</span>
                        ) : null}
                        <span className="text-slate-600"> × {item.quantity}</span>
                      </span>
                      <span className="tabular-nums text-slate-700">
                        {formatMoney(item.unitPriceCents * item.quantity, subscription.currency)}
                      </span>
                    </li>
                  ))}
                </ul>

                <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-slate-500">Goods each delivery</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-slate-900">
                      {formatMoney(subscription.subtotalCents, subscription.currency)}
                    </dd>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Delivery and tax are added at each renewal.
                    </p>
                  </div>
                  <div>
                    <dt className="text-slate-500">Next payment</dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {subscription.status === 'PAUSED'
                        ? 'Paused'
                        : subscription.nextBillingAt
                          ? formatDate(subscription.nextBillingAt)
                          : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Card</dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {subscription.paymentMethod
                        ? `${subscription.paymentMethod.cardBrand ?? 'Card'} ending ${
                            subscription.paymentMethod.cardLast4 ?? '????'
                          }`
                        : 'None saved'}
                    </dd>
                  </div>
                </dl>

                <SubscriptionControls subscription={subscription} paymentMethods={paymentMethods} />
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm text-slate-600">
        Subscriptions renew automatically until you cancel. Cancelling takes effect immediately and
        needs no explanation.
      </p>
    </div>
  );
}
