import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, PageHeader, TableShell, Td, Th } from '@health/ui';
import {
  getOrder,
  humanise,
  orderStatusTone,
  type AdminOrder,
  type AdminOrderAddress,
} from '@/lib/commerce';
import { ApiError } from '@/lib/api-client';
import { currentUser } from '@/lib/session';
import { formatDateTime, formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { CancelOrderForm, OrderNoteForm } from '@/components/order-actions';
import { RefundForm } from '@/components/refund-form';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Order' };

/**
 * One order.
 *
 * The timeline is the centre of this screen rather than an afterthought,
 * because it is the only complete answer to "what happened to this order and
 * who did it". It is append-only in the database: a trigger refuses updates and
 * deletes, so nothing on this page can be quietly rewritten later.
 */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'ORDER_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="ORDER_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;

  let order: AdminOrder;
  try {
    order = await getOrder(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const captured = order.payments.reduce((sum, payment) => sum + payment.amountCapturedCents, 0);
  const refundableCents = Math.max(0, captured - order.amountRefundedCents);
  const terminal = order.status === 'CANCELLED' || order.status === 'REFUNDED';

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={order.reference}
          description={`Placed ${formatDateTime(order.placedAt)} by ${order.email}`}
          actions={<Badge tone={orderStatusTone(order.status)}>{humanise(order.status)}</Badge>}
        />

        <Link href="/orders" className="inline-block text-sm text-brand-700 hover:underline">
          ← All orders
        </Link>

        {!order.paymentIsRealMoney ? (
          <Alert tone="warning" title="Paid through the development adapter">
            This order was settled by the stand-in payment provider, which does not move real money.
            Nothing was charged and nothing can be refunded to a real card.
          </Alert>
        ) : null}

        {order.status === 'PENDING_PAYMENT' ? (
          <Alert tone="info" title="Not paid yet">
            Stock is held for this order but no money has settled. It becomes a real order when the
            provider confirms the payment, not when the customer's browser says so.
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Items</h2>
              <div className="mt-4">
                <TableShell caption={`Lines on order ${order.reference}`}>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th className="text-right">Qty</Th>
                      <Th className="text-right">Unit</Th>
                      <Th className="text-right">Line total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => (
                      <tr key={item.id}>
                        <Td>
                          <span className="font-medium text-slate-900">{item.productName}</span>
                          <span className="block text-xs text-slate-500">{item.variantName}</span>
                          <span className="block font-mono text-xs text-slate-500">{item.sku}</span>
                          {item.quantityRefunded > 0 ? (
                            <span className="mt-1 block text-xs text-amber-700">
                              {item.quantityRefunded} refunded
                            </span>
                          ) : null}
                        </Td>
                        <Td className="text-right tabular-nums">{item.quantity}</Td>
                        <Td className="text-right tabular-nums">
                          {formatMoney(item.unitPriceCents, order.currency)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatMoney(item.lineTotalCents, order.currency)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>

              <dl className="mt-4 space-y-1 border-t border-slate-200 pt-4 text-sm">
                <Money label="Subtotal" cents={order.subtotalCents} currency={order.currency} />
                {order.discountCents > 0 ? (
                  <Money label="Discount" cents={-order.discountCents} currency={order.currency} />
                ) : null}
                <Money
                  label={order.shippingMethodName ?? 'Shipping'}
                  cents={order.shippingCents}
                  currency={order.currency}
                />
                <Money label="Tax" cents={order.taxCents} currency={order.currency} />
                <Money label="Total" cents={order.totalCents} currency={order.currency} strong />
                <Money label="Paid" cents={order.amountPaidCents} currency={order.currency} />
                {order.amountRefundedCents > 0 ? (
                  <Money
                    label="Refunded"
                    cents={order.amountRefundedCents}
                    currency={order.currency}
                  />
                ) : null}
              </dl>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Timeline</h2>
              <p className="mt-1 text-sm text-slate-600">
                Append-only. Entries cannot be edited or removed, by anyone, including here.
              </p>
              <ol className="mt-4 space-y-3">
                {order.events.map((event) => (
                  <li key={event.id} className="border-l-2 border-slate-200 pl-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-slate-500">{event.type}</span>
                      <span className="text-xs text-slate-400">
                        {formatDateTime(event.createdAt)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {event.isSystem ? 'system' : (event.actorLabel ?? 'unknown')}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-800">{event.message}</p>
                  </li>
                ))}
              </ol>

              <div className="mt-6 border-t border-slate-200 pt-4">
                <OrderNoteForm orderId={order.id} canWrite={hasPermission(user, 'ORDER_WRITE')} />
              </div>
            </Card>

            {hasPermission(user, 'REFUND_READ') ? (
              <Card>
                <h2 className="text-lg font-semibold text-slate-900">Refunds</h2>
                {order.refunds.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-600">Nothing has been refunded.</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {order.refunds.map((refund) => (
                      <li key={refund.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium tabular-nums text-slate-900">
                            {formatMoney(refund.amountCents, refund.currency)}
                          </span>
                          <Badge tone={refund.status === 'SUCCEEDED' ? 'success' : 'warning'}>
                            {humanise(refund.status)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {humanise(refund.reason)} · {refund.actorLabel} ·{' '}
                          {formatDateTime(refund.createdAt)}
                        </p>
                        <p className="mt-1 text-sm text-slate-700">{refund.notes}</p>
                        {refund.failureMessage ? (
                          <p className="mt-1 text-sm text-red-700">{refund.failureMessage}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {!terminal ? (
                  <div className="mt-6 border-t border-slate-200 pt-4">
                    <h3 className="text-sm font-semibold text-slate-900">Issue a refund</h3>
                    <div className="mt-3">
                      <RefundForm
                        orderId={order.id}
                        currency={order.currency}
                        refundableCents={refundableCents}
                        items={order.items}
                        canRefund={hasPermission(user, 'REFUND_ISSUE')}
                        mfaEnabled={user.mfaEnabled}
                      />
                    </div>
                  </div>
                ) : null}
              </Card>
            ) : null}
          </div>

          <div className="space-y-6">
            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Shipping to</h2>
              <Address address={order.shippingAddress} />
              {order.shippingMethodName ? (
                <p className="mt-3 text-sm text-slate-600">via {order.shippingMethodName}</p>
              ) : null}
            </Card>

            {order.billingAddress ? (
              <Card>
                <h2 className="text-sm font-semibold text-slate-900">Billing</h2>
                <Address address={order.billingAddress} />
              </Card>
            ) : null}

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Payments</h2>
              {order.payments.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No payment has been created yet.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {order.payments.map((payment) => (
                    <li key={payment.id} className="text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="tabular-nums text-slate-900">
                          {formatMoney(payment.amountCents, payment.currency)}
                        </span>
                        <Badge tone={payment.status === 'CAPTURED' ? 'success' : 'neutral'}>
                          {humanise(payment.status)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {payment.provider}
                        {payment.cardLast4
                          ? ` · ${payment.cardBrand ?? 'card'} ending ${payment.cardLast4}`
                          : ''}
                      </p>
                      {payment.failureMessage ? (
                        <p className="mt-1 text-xs text-red-700">{payment.failureMessage}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-slate-500">
                Card numbers are never sent to this application, so there is nothing more to show
                here than the brand and last four digits the provider reports.
              </p>
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Fulfilment</h2>
              <p className="mt-2 text-sm text-slate-700">{humanise(order.fulfilmentStatus)}</p>
              {order.shipments.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">
                  Nothing has shipped. Creating shipments and buying labels arrives with the
                  fulfilment provider integration.
                </p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm">
                  {order.shipments.map((shipment) => (
                    <li key={shipment.id}>
                      <span className="text-slate-900">{humanise(shipment.status)}</span>
                      {shipment.trackingNumber ? (
                        <span className="block font-mono text-xs text-slate-500">
                          {shipment.carrier} {shipment.trackingNumber}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {!terminal ? (
              <Card>
                <h2 className="text-sm font-semibold text-slate-900">Cancel</h2>
                <div className="mt-3">
                  <CancelOrderForm
                    orderId={order.id}
                    canCancel={hasPermission(user, 'ORDER_CANCEL')}
                    hasCapturedPayment={captured > 0}
                  />
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
}

function Money({
  label,
  cents,
  currency,
  strong,
}: {
  label: string;
  cents: number;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? 'font-semibold text-slate-900' : 'text-slate-600'}>{label}</dt>
      <dd
        className={
          strong ? 'font-semibold tabular-nums text-slate-900' : 'tabular-nums text-slate-700'
        }
      >
        {formatMoney(cents, currency)}
      </dd>
    </div>
  );
}

function Address({ address }: { address: AdminOrderAddress }) {
  return (
    <address className="mt-2 text-sm not-italic text-slate-700">
      {address.firstName} {address.lastName}
      <br />
      {address.company ? (
        <>
          {address.company}
          <br />
        </>
      ) : null}
      {address.line1}
      <br />
      {address.line2 ? (
        <>
          {address.line2}
          <br />
        </>
      ) : null}
      {address.city}, {address.region} {address.postalCode}
      <br />
      {address.country}
    </address>
  );
}
