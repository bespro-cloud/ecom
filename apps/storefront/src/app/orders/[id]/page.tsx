import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert } from '@health/ui';
import { ApiError } from '@/lib/api-client';
import { fetchOrder, orderStatusLabel, type OrderDetail } from '@/lib/commerce';
import { formatDate, formatMoney } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Your order',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

async function load(id: string): Promise<OrderDetail> {
  try {
    return await fetchOrder(id);
  } catch (error) {
    // The API scopes every order query by the caller's own customer record, so
    // someone else's order is genuinely not found rather than forbidden.
    if (error instanceof ApiError && (error.status === 404 || error.isAuthError)) notFound();
    throw error;
  }
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const order = await load(id);
  const justPlaced = query.placed === '1';

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      {justPlaced ? (
        <Alert tone="success" title="Thank you — your order is placed">
          {/*
            Deliberately does not promise a confirmation email. Nothing sends
            one yet, and telling a customer to watch their inbox for something
            that will never arrive is worse than saying nothing.
          */}
          Your order reference is <span className="font-mono font-medium">{order.reference}</span>.
          Keep this page bookmarked — you can come back to it from this browser at any time.
        </Alert>
      ) : null}

      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-mono text-2xl font-semibold tracking-tight text-slate-900">
          {order.reference}
        </h1>
        <p className="text-sm text-slate-600">Placed {formatDate(order.placedAt)}</p>
      </div>

      <p className="mt-1 text-sm font-medium text-slate-700">{orderStatusLabel(order.status)}</p>

      {order.amountRefundedCents > 0 ? (
        <Alert tone="info" className="mt-4">
          {formatMoney(order.amountRefundedCents, order.currency)} has been refunded to your
          original payment method. It can take a few working days to appear.
        </Alert>
      ) : null}

      <section aria-labelledby="items-heading" className="mt-8">
        <h2 id="items-heading" className="text-lg font-semibold text-slate-900">
          What you ordered
        </h2>

        <ul className="mt-3 divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">{item.productName}</p>
                <p className="text-sm text-slate-600">{item.variantName}</p>
                <p className="font-mono text-xs text-slate-500">{item.sku}</p>
                <p className="mt-1 text-sm text-slate-600">
                  Quantity {item.quantity}
                  {item.quantityRefunded > 0 ? ` · ${item.quantityRefunded} refunded` : ''}
                </p>
              </div>
              <p className="shrink-0 font-medium text-slate-900">
                {formatMoney(item.lineTotalCents, order.currency)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="totals-heading" className="mt-6">
        <h2 id="totals-heading" className="sr-only">
          Totals
        </h2>
        <dl className="space-y-2 rounded-xl bg-white p-5 text-sm ring-1 ring-slate-200">
          <div className="flex justify-between">
            <dt className="text-slate-600">Subtotal</dt>
            <dd className="text-slate-900">{formatMoney(order.subtotalCents, order.currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-600">Delivery</dt>
            <dd className="text-slate-900">{formatMoney(order.shippingCents, order.currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-600">Tax</dt>
            <dd className="text-slate-900">{formatMoney(order.taxCents, order.currency)}</dd>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
            <dt className="text-slate-900">Total</dt>
            <dd className="text-slate-900">{formatMoney(order.totalCents, order.currency)}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="delivery-heading" className="mt-6">
        <h2 id="delivery-heading" className="text-lg font-semibold text-slate-900">
          Delivery
        </h2>
        <address className="mt-2 not-italic text-sm leading-relaxed text-slate-700">
          {order.shippingAddress.firstName} {order.shippingAddress.lastName}
          <br />
          {order.shippingAddress.line1}
          <br />
          {order.shippingAddress.line2 ? (
            <>
              {order.shippingAddress.line2}
              <br />
            </>
          ) : null}
          {order.shippingAddress.city}, {order.shippingAddress.region}{' '}
          {order.shippingAddress.postalCode}
        </address>

        {order.shipments.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm">
            {order.shipments.map((shipment) => (
              <li key={shipment.id} className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
                <p className="font-medium text-slate-900">
                  {shipment.carrier ?? 'Shipment'} — {shipment.status.toLowerCase()}
                </p>
                {shipment.trackingNumber ? (
                  <p className="text-slate-600">
                    Tracking:{' '}
                    {shipment.trackingUrl ? (
                      <a
                        href={shipment.trackingUrl}
                        rel="noopener noreferrer nofollow"
                        target="_blank"
                        className="text-brand-700 underline"
                      >
                        {shipment.trackingNumber}
                      </a>
                    ) : (
                      <span className="font-mono">{shipment.trackingNumber}</span>
                    )}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            Nothing has shipped yet. We will email you when it does.
          </p>
        )}
      </section>

      <p className="mt-8">
        <Link href="/orders" className="text-sm font-medium text-brand-700 hover:underline">
          All your orders
        </Link>
      </p>
    </div>
  );
}
