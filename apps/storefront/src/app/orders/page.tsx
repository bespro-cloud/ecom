import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchOrders, orderStatusLabel } from '@/lib/commerce';
import { formatDate, formatMoney } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Your orders',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  const orders = await fetchOrders();

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Your orders</h1>

      {orders.length === 0 ? (
        <p className="mt-8 rounded-xl bg-white p-10 text-center text-sm text-slate-600 ring-1 ring-slate-200">
          You have not placed an order yet.
        </p>
      ) : (
        <ul className="mt-8 space-y-4">
          {orders.map((order) => (
            <li key={order.id} className="rounded-xl bg-white p-5 ring-1 ring-slate-200">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/orders/${order.id}`}
                  className="font-mono font-medium text-slate-900 hover:underline"
                >
                  {order.reference}
                </Link>
                <span className="text-sm text-slate-600">{formatDate(order.placedAt)}</span>
              </div>

              <p className="mt-1 text-sm text-slate-600">
                {orderStatusLabel(order.status)} ·{' '}
                {order.items.reduce((sum, item) => sum + item.quantity, 0)} item
                {order.items.length === 1 ? '' : 's'} ·{' '}
                {formatMoney(order.totalCents, order.currency)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
