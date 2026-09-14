import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { humanise, listSubscriptions } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDate, formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Subscriptions' };

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  ACTIVE: 'success',
  PENDING: 'info',
  PAUSED: 'neutral',
  PAST_DUE: 'warning',
  UNPAID: 'danger',
  CANCELLED: 'neutral',
};

/**
 * Subscriptions.
 *
 * Read-only here by design. Renewals are charged by the scheduled billing run
 * calling the same function the API does; there is no button on this page that
 * takes a payment, because a staff member charging a card by hand is exactly
 * the path that produces duplicate charges nobody can reconcile.
 */
export default async function SubscriptionsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'SUBSCRIPTION_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="SUBSCRIPTION_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listSubscriptions('limit=100');
  const failing = data.filter(
    (subscription) => subscription.status === 'PAST_DUE' || subscription.status === 'UNPAID',
  );

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Subscriptions"
          description="Repeat deliveries and their billing state. Prices are the ones each customer agreed to, not today's catalogue price."
        />

        {failing.length > 0 ? (
          <Alert tone="warning" title={`${failing.length} subscription(s) have a payment problem`}>
            Nothing is dispatched against a renewal that did not settle. Past-due subscriptions are
            retried on a bounded schedule; unpaid ones have exhausted it and will not be retried
            again.
          </Alert>
        ) : null}

        <Card>
          {data.length === 0 ? (
            <EmptyState
              title="No subscriptions"
              description="Customers start these from a product page."
            />
          ) : (
            <TableShell caption="Subscriptions, newest first">
              <thead>
                <tr>
                  <Th>Reference</Th>
                  <Th>Customer</Th>
                  <Th>Items</Th>
                  <Th>Cadence</Th>
                  <Th className="text-right">Goods</Th>
                  <Th>Next payment</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((subscription) => (
                  <tr key={subscription.id}>
                    <Td>
                      <Link
                        href={`/subscriptions/${subscription.id}`}
                        className="font-mono text-sm font-medium text-slate-900 hover:underline"
                      >
                        {subscription.reference}
                      </Link>
                    </Td>
                    <Td className="font-mono text-sm">{subscription.customerReference ?? '—'}</Td>
                    <Td className="text-sm">
                      {subscription.items
                        .map((item) => `${item.productName} × ${item.quantity}`)
                        .join(', ')}
                    </Td>
                    <Td className="text-sm">
                      {subscription.intervalCount === 1
                        ? `Every ${subscription.interval.toLowerCase()}`
                        : `Every ${subscription.intervalCount} ${subscription.interval.toLowerCase()}s`}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatMoney(subscription.subtotalCents, subscription.currency)}
                    </Td>
                    <Td className="text-sm">
                      {subscription.nextBillingAt ? formatDate(subscription.nextBillingAt) : '—'}
                    </Td>
                    <Td>
                      <Badge tone={TONE[subscription.status] ?? 'neutral'}>
                        {humanise(subscription.status)}
                      </Badge>
                      {subscription.failedAttempts > 0 ? (
                        <span className="block text-xs text-slate-500">
                          {subscription.failedAttempts} failed attempt(s)
                        </span>
                      ) : null}
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
