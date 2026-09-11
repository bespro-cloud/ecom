import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { humanise, listOrders, orderStatusTone } from '@/lib/commerce';
import { currentUser } from '@/lib/session';
import { formatDateTime, formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { OrderFilters } from '@/components/order-filters';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Orders' };

/**
 * The order list.
 *
 * Only the filters the API actually supports are offered. A filter the server
 * ignores is worse than no filter: the screen looks like it narrowed the list
 * and quietly did not.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'ORDER_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="ORDER_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['reference', 'email', 'status', 'from', 'to'] as const) {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (single) query.set(key, single);
  }
  query.set('limit', '50');

  const { data, meta } = await listOrders(query.toString());

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Orders"
          description="Every order, with what was charged and what has been refunded. Totals are the ones stored at the time of sale, not today's prices."
        />

        <Card>
          <OrderFilters params={params} />
        </Card>

        <Card>
          {data.length === 0 ? (
            <EmptyState
              title="No orders match"
              description="Widen the filters, or check the reference is exactly as the customer has it."
            />
          ) : (
            <>
              <TableShell caption="Orders, most recently placed first">
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                    <Th>Payment</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Placed</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((order) => (
                    <tr key={order.id}>
                      <Td>
                        <Link
                          href={`/orders/${order.id}`}
                          className="font-mono text-sm font-medium text-slate-900 hover:underline"
                        >
                          {order.reference}
                        </Link>
                        <span className="block text-xs text-slate-500">
                          {order._count.items} {order._count.items === 1 ? 'line' : 'lines'}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-sm text-slate-700">{order.email}</span>
                      </Td>
                      <Td>
                        <Badge tone={orderStatusTone(order.status)}>{humanise(order.status)}</Badge>
                      </Td>
                      <Td>
                        <span className="text-sm text-slate-700">
                          {humanise(order.paymentStatus)}
                        </span>
                        {order.amountRefundedCents > 0 ? (
                          <span className="block text-xs text-amber-700">
                            {formatMoney(order.amountRefundedCents, order.currency)} refunded
                          </span>
                        ) : null}
                      </Td>
                      <Td className="text-right font-medium tabular-nums">
                        {formatMoney(order.totalCents, order.currency)}
                      </Td>
                      <Td>{formatDateTime(order.placedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>

              {meta.hasMore ? (
                <p className="mt-4 text-sm text-slate-500">
                  More orders match than are shown. Narrow the dates or the status to see the rest.
                </p>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}
