import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, PageHeader, TableShell, Td, Th } from '@health/ui';
import {
  getRecall,
  getRecallImpact,
  humanise,
  recallTone,
  type AdminRecall,
  type RecallImpact,
} from '@/lib/compliance';
import { ApiError } from '@/lib/api-client';
import { currentUser } from '@/lib/session';
import { formatDate, formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { RecallNotificationForm } from '@/components/recall-notification-form';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = {
  title: 'Recall',
  // A recall page lists affected orders once contact is approved. It has no
  // business in a search index or a referrer header.
  robots: { index: false, follow: false },
};

/**
 * The recall console.
 *
 * Organised around the one distinction that matters: **what has been done to
 * the stock** versus **what has been authorised about the customers**. Those
 * are different decisions with different authorities, and a screen that ran
 * them together would make the second feel like a consequence of the first.
 *
 * Before contact is approved the impact panel shows counts only. That
 * withholding is enforced in the API — this page cannot reveal identities by
 * asking differently — but showing the counts here is deliberate too: someone
 * briefing a regulator needs the scale, and should not have to request the
 * contact list to get it.
 */
export default async function RecallPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'RECALL_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="RECALL_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;

  let recall: AdminRecall;
  let impact: RecallImpact;
  try {
    [recall, impact] = await Promise.all([getRecall(id), getRecallImpact(id)]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const live = recall.status === 'OPEN' || recall.status === 'NOTIFICATION_APPROVED';

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={recall.reference}
          description={recall.title}
          actions={<Badge tone={recallTone(recall.status)}>{humanise(recall.status)}</Badge>}
        />

        <Link href="/recalls" className="inline-block text-sm text-brand-700 hover:underline">
          ← All recalls
        </Link>

        {live ? (
          <Alert tone="error" title="Affected stock is withdrawn from sale">
            {recall.lots.length} lot(s) are recalled and cannot be allocated to any order.
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Why</h2>
              <p className="mt-2 text-sm text-slate-800">{recall.reason}</p>
              {recall.hazard ? (
                <>
                  <h3 className="mt-4 text-sm font-semibold text-slate-900">Hazard</h3>
                  <p className="mt-1 text-sm text-slate-800">{recall.hazard}</p>
                </>
              ) : null}
              <p className="mt-4 text-xs text-slate-500">
                Classification: {humanise(recall.classification)} — recorded by a person, never
                computed. It is a regulatory judgement about probability of harm.
              </p>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Who is affected</h2>

              <dl className="mt-4 grid grid-cols-3 gap-4">
                <Stat label="Orders" value={impact.orderCount} />
                <Stat label="Customers" value={impact.customerCount} />
                <Stat label="Units shipped" value={impact.unitsShipped} />
              </dl>

              {impact.byProduct.length > 0 ? (
                <ul className="mt-4 space-y-1 text-sm text-slate-700">
                  {impact.byProduct.map((entry) => (
                    <li key={entry.productId}>
                      {entry.productName} — {entry.units} unit(s)
                    </li>
                  ))}
                </ul>
              ) : null}

              <Alert tone={impact.notificationApproved ? 'warning' : 'info'} className="mt-4">
                {impact.disclosureNote}
              </Alert>

              {impact.orders ? (
                <div className="mt-4">
                  <TableShell caption="Orders that received the recalled lots">
                    <thead>
                      <tr>
                        <Th>Order</Th>
                        <Th>Customer</Th>
                        <Th>Placed</Th>
                        <Th className="text-right">Units</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.orders.map((order) => (
                        <tr key={order.orderId}>
                          <Td>
                            <Link
                              href={`/orders/${order.orderId}`}
                              className="font-mono text-sm hover:underline"
                            >
                              {order.reference}
                            </Link>
                          </Td>
                          <Td>{order.email}</Td>
                          <Td>{formatDate(order.placedAt)}</Td>
                          <Td className="text-right tabular-nums">{order.units}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                </div>
              ) : null}
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Lots in scope</h2>
              <div className="mt-4">
                <TableShell caption="Lots withdrawn under this recall">
                  <thead>
                    <tr>
                      <Th>Lot</Th>
                      <Th>Product</Th>
                      <Th>Warehouse</Th>
                      <Th className="text-right">At recall</Th>
                      <Th className="text-right">Remaining</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {recall.lots.map((lot) => (
                      <tr key={lot.id}>
                        <Td>
                          <Link
                            href={`/lots/${lot.batchId}`}
                            className="font-mono text-sm hover:underline"
                          >
                            {lot.lotCode}
                          </Link>
                        </Td>
                        <Td>
                          <span className="text-sm text-slate-700">{lot.productName}</span>
                          <span className="block font-mono text-xs text-slate-500">{lot.sku}</span>
                        </Td>
                        <Td>
                          <span className="font-mono text-xs">{lot.warehouse.code}</span>
                        </Td>
                        <Td className="text-right tabular-nums">{lot.quantityAtRecall}</Td>
                        <Td className="text-right tabular-nums">{lot.quantityOnHand}</Td>
                        <Td>
                          <Badge tone={lot.status === 'RECALLED' ? 'danger' : 'neutral'}>
                            {humanise(lot.status)}
                          </Badge>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Action log</h2>
              <p className="mt-1 text-sm text-slate-600">
                Append-only and retained indefinitely. This is the regulatory record of the
                response.
              </p>
              <ol className="mt-4 space-y-3">
                {recall.actions.map((action) => (
                  <li key={action.id} className="border-l-2 border-slate-200 pl-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-slate-500">{action.type}</span>
                      <span className="text-xs text-slate-400">
                        {formatDateTime(action.createdAt)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {action.isSystem ? 'system' : (action.actorLabel ?? 'unknown')}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-800">{action.message}</p>
                  </li>
                ))}
              </ol>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Customer contact</h2>
              <div className="mt-3">
                {recall.notificationApproved ? (
                  <Alert tone="warning" title="Approved">
                    <p>
                      {recall.notificationApprovedByLabel} approved contacting affected customers on{' '}
                      {recall.notificationApprovedAt
                        ? formatDateTime(recall.notificationApprovedAt)
                        : 'an unknown date'}
                      .
                    </p>
                    <p className="mt-2">
                      This system has sent nothing. Reaching out remains a manual act.
                    </p>
                  </Alert>
                ) : recall.status === 'OPEN' ? (
                  <RecallNotificationForm
                    recallId={recall.id}
                    customerCount={impact.customerCount}
                    canApprove={hasPermission(user, 'RECALL_NOTIFY')}
                    mfaEnabled={user.mfaEnabled}
                  />
                ) : (
                  <p className="text-sm text-slate-600">
                    Customer contact can only be approved on an open recall.
                  </p>
                )}
              </div>
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Regulator</h2>
              {recall.regulatorNotifiedAt ? (
                <p className="mt-2 text-sm text-slate-700">
                  Notified {formatDate(recall.regulatorNotifiedAt)}
                  {recall.regulatorReference ? ` · ${recall.regulatorReference}` : ''}
                </p>
              ) : (
                <p className="mt-2 text-sm text-slate-600">
                  No regulator notification is recorded against this recall.
                </p>
              )}
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Timeline</h2>
              <dl className="mt-3 space-y-1 text-sm">
                <TextRow label="Drafted" value={formatDate(recall.createdAt)} />
                <TextRow
                  label="Opened"
                  value={recall.openedAt ? formatDate(recall.openedAt) : 'not yet'}
                />
                <TextRow
                  label="Closed"
                  value={recall.closedAt ? formatDate(recall.closedAt) : 'not yet'}
                />
              </dl>
              {recall.openedByLabel ? (
                <p className="mt-2 text-xs text-slate-500">Opened by {recall.openedByLabel}</p>
              ) : null}
            </Card>
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

function TextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-600">{label}</dt>
      <dd className="text-right text-slate-700">{value}</dd>
    </div>
  );
}
