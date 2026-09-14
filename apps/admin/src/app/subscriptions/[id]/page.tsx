import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { getSubscription, humanise } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Subscription' };

export default async function SubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'SUBSCRIPTION_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="SUBSCRIPTION_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;
  const subscription = await getSubscription(id);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={subscription.reference}
          description={`${humanise(subscription.status)} · started ${formatDate(subscription.createdAt)}`}
          actions={<Badge tone="neutral">{humanise(subscription.status)}</Badge>}
        />

        {subscription.status === 'PAST_DUE' ? (
          <Alert tone="warning" title="A renewal did not settle">
            <p>
              Nothing will be dispatched until it does. Collection is retried on a bounded schedule
              — {subscription.failedAttempts} attempt(s) so far
              {subscription.lastFailureCode ? `, last failure ${subscription.lastFailureCode}` : ''}
              .
            </p>
          </Alert>
        ) : null}

        {subscription.status === 'UNPAID' ? (
          <Alert tone="error" title="Collection has been abandoned">
            <p>
              The retry schedule is exhausted after {subscription.failedAttempts} attempt(s). The
              card will not be tried again: a card that has declined this many times will not work
              on the next one, and a business that keeps asking gets treated as a problem by the
              issuer. The customer has been told.
            </p>
          </Alert>
        ) : null}

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Items</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {subscription.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-3 py-2">
                <span>
                  <span className="text-slate-900">{item.productName}</span>
                  {item.variantName ? (
                    <span className="text-slate-600"> — {item.variantName}</span>
                  ) : null}
                  <span className="block font-mono text-xs text-slate-500">{item.sku}</span>
                </span>
                <span className="shrink-0 tabular-nums text-slate-900">
                  {item.quantity} × {formatMoney(item.unitPriceCents, subscription.currency)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-slate-200 pt-3 text-sm text-slate-600">
            Goods total{' '}
            <span className="font-semibold tabular-nums text-slate-900">
              {formatMoney(subscription.subtotalCents, subscription.currency)}
            </span>{' '}
            each delivery. Delivery and tax are computed at each renewal, so this is not the amount
            charged.
          </p>
          <p className="mt-2 text-sm text-slate-500">
            These are the prices the customer agreed to. A catalogue price change does not reach an
            existing subscription — changing what a subscriber pays needs their agreement.
          </p>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Billing</h2>
          <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Current period</dt>
              <dd className="mt-0.5 text-slate-900">
                {formatDate(subscription.currentPeriodStart)} —{' '}
                {formatDate(subscription.currentPeriodEnd)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Next charge</dt>
              <dd className="mt-0.5 text-slate-900">
                {subscription.nextBillingAt ? formatDate(subscription.nextBillingAt) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Card</dt>
              <dd className="mt-0.5 text-slate-900">
                {subscription.paymentMethod
                  ? `${subscription.paymentMethod.cardBrand ?? 'Card'} ending ${
                      subscription.paymentMethod.cardLast4 ?? '????'
                    }${subscription.paymentMethod.detached ? ' (removed)' : ''}`
                  : 'None'}
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">History</h2>
          {subscription.events.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">Nothing recorded yet.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {subscription.events.map((event) => (
                <li key={event.id} className="border-l-2 border-slate-200 pl-4">
                  <p className="text-sm font-medium text-slate-900">{humanise(event.type)}</p>
                  {event.message ? (
                    <p className="mt-0.5 text-sm text-slate-700">{event.message}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-slate-500">
                    {event.isSystem ? 'System' : (event.actorLabel ?? 'Unknown')} ·{' '}
                    {formatDateTime(event.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <p className="text-sm">
          <Link href="/subscriptions" className="text-brand-700 hover:text-brand-800">
            Back to subscriptions
          </Link>
        </p>
      </div>
    </ConsoleShell>
  );
}
