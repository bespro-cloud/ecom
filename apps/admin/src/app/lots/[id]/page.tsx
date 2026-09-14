import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { batchTone, getBatch, humanise } from '@/lib/compliance';
import { ApiError } from '@/lib/api-client';
import { currentUser } from '@/lib/session';
import { formatDate, formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { LotDispositionForm } from '@/components/lot-disposition-form';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Lot' };

export default async function LotPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'BATCH_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="BATCH_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;

  let batch: Awaited<ReturnType<typeof getBatch>>;
  try {
    batch = await getBatch(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={batch.lotCode}
          description={`${batch.variant.productName} · ${batch.variant.sku} · ${batch.warehouse.name}`}
          actions={<Badge tone={batchTone(batch.status)}>{humanise(batch.status)}</Badge>}
        />

        <Link href="/lots" className="inline-block text-sm text-brand-700 hover:underline">
          ← All lots
        </Link>

        {batch.status === 'RECALLED' ? (
          <Alert tone="error" title="This lot is recalled">
            It can never return to sale. Correcting a mistaken recall means receiving the goods
            again as a new lot, so the receipt is on record.
          </Alert>
        ) : null}

        {batch.pastExpiry && batch.status === 'AVAILABLE' ? (
          <Alert tone="warning" title="Past its stated expiry">
            This lot is still marked available. The hourly sweep will withdraw it; until then it
            could be allocated.
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">History</h2>
              <p className="mt-1 text-sm text-slate-600">
                Append-only. Every disposition change, with the reason and who made it — none of
                which can be edited afterwards.
              </p>
              <ol className="mt-4 space-y-3">
                {batch.events.map((event) => (
                  <li key={event.id} className="border-l-2 border-slate-200 pl-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-slate-500">{event.type}</span>
                      {event.fromStatus && event.toStatus ? (
                        <span className="text-xs text-slate-500">
                          {humanise(event.fromStatus)} → {humanise(event.toStatus)}
                        </span>
                      ) : null}
                      <span className="text-xs text-slate-400">
                        {formatDateTime(event.createdAt)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {event.isSystem ? 'system' : (event.actorLabel ?? 'unknown')}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-800">{event.reason}</p>
                  </li>
                ))}
              </ol>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Documents</h2>
              {batch.documents.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">
                  No certificate of analysis or test report is held against this lot.
                </p>
              ) : (
                <ul className="mt-4 space-y-2">
                  {batch.documents.map((document) => (
                    <li key={document.id} className="text-sm">
                      <span className="font-medium text-slate-900">{document.title}</span>
                      <span className="ml-2 text-xs text-slate-500">{humanise(document.type)}</span>
                      {document.expired ? (
                        <Badge tone="danger" className="ml-2">
                          expired
                        </Badge>
                      ) : null}
                      {document.issuerAsStated ? (
                        <span className="block text-xs text-slate-500">
                          Issuer as stated: {document.issuerAsStated}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-slate-500">
                Documents record what an uploader said a file is. This system does not verify an
                issuer or check a certificate against any registry.
              </p>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Quantities</h2>
              <dl className="mt-3 space-y-1 text-sm">
                <Row label="On hand" value={batch.quantityOnHand} />
                <Row label="Reserved" value={batch.quantityReserved} />
                <Row label="Allocatable" value={batch.quantityAllocatable} strong />
              </dl>
              {batch.quantityAllocatable === 0 && batch.quantityOnHand > 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  The units exist; they just cannot be sold in this state.
                </p>
              ) : null}
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Dates</h2>
              <dl className="mt-3 space-y-1 text-sm">
                <TextRow label="Received" value={formatDate(batch.receivedAt)} />
                <TextRow
                  label="Manufactured"
                  value={batch.manufacturedAt ? formatDate(batch.manufacturedAt) : 'not stated'}
                />
                <TextRow
                  label="Expires"
                  value={batch.expiresAt ? formatDate(batch.expiresAt) : 'not stated'}
                />
              </dl>
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Supplier</h2>
              <p className="mt-2 text-sm text-slate-700">
                {batch.supplierAsStated ?? 'Not recorded'}
              </p>
              {batch.supplierReference ? (
                <p className="font-mono text-xs text-slate-500">{batch.supplierReference}</p>
              ) : null}
              <p className="mt-2 text-xs text-slate-500">As stated at receipt, not verified.</p>
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Disposition</h2>
              <div className="mt-3">
                <LotDispositionForm
                  batchId={batch.id}
                  currentStatus={batch.status}
                  quantityReserved={batch.quantityReserved}
                  canManage={hasPermission(user, 'BATCH_QUARANTINE')}
                />
              </div>
            </Card>
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? 'font-semibold text-slate-900' : 'text-slate-600'}>{label}</dt>
      <dd
        className={
          strong ? 'font-semibold tabular-nums text-slate-900' : 'tabular-nums text-slate-700'
        }
      >
        {value}
      </dd>
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
