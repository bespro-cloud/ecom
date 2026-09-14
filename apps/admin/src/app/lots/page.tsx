import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { batchTone, humanise, listBatches } from '@/lib/compliance';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Lots' };

/**
 * Lots, earliest expiry first — the order they will actually be allocated in.
 *
 * The column that matters most is **allocatable**: how many units could still
 * be sold. It is zero for anything not available, however many units are
 * physically on the shelf, and keeping those two numbers visibly separate is
 * the whole point of the screen.
 */
export default async function LotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'BATCH_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="BATCH_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const single = (key: string): string => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  const query = new URLSearchParams();
  if (single('search')) query.set('search', single('search'));
  if (single('status')) query.set('status', single('status'));
  if (single('expiringWithinDays')) query.set('expiringWithinDays', single('expiringWithinDays'));
  query.set('limit', '100');

  const { data } = await listBatches(query.toString());
  const blocked = data.filter((batch) => batch.status !== 'AVAILABLE');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Lots"
          description="Stock by lot, in the order it will be allocated: earliest expiry first. Only available lots can be sold; quarantined, recalled and expired units stay counted but cannot ship."
        />

        {blocked.length > 0 ? (
          <Alert tone="warning">
            {blocked.length} lot(s) are on the shelf but not sellable. Their units still count as on
            hand, which is why a stock figure and an availability figure can differ.
          </Alert>
        ) : null}

        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="lot-search" className="block text-sm font-medium text-slate-700">
                Search
              </label>
              <input
                id="lot-search"
                type="search"
                name="search"
                defaultValue={single('search')}
                placeholder="Lot code, SKU or supplier"
                maxLength={200}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>

            <div>
              <label htmlFor="lot-status" className="block text-sm font-medium text-slate-700">
                Status
              </label>
              <select
                id="lot-status"
                name="status"
                defaultValue={single('status')}
                className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                <option value="">Any</option>
                {['AVAILABLE', 'QUARANTINED', 'RECALLED', 'EXPIRED', 'DISPOSED'].map((status) => (
                  <option key={status} value={status}>
                    {humanise(status)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="lot-expiring" className="block text-sm font-medium text-slate-700">
                Expiring within
              </label>
              <select
                id="lot-expiring"
                name="expiringWithinDays"
                defaultValue={single('expiringWithinDays')}
                className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                <option value="">Any date</option>
                <option value="0">Already past</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
              </select>
            </div>

            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Apply
            </button>
          </form>
        </Card>

        <Card>
          {data.length === 0 ? (
            <EmptyState
              title="No lots match"
              description="Lots are created by receiving stock against a variant and warehouse."
            />
          ) : (
            <TableShell caption="Lots, earliest expiry first">
              <thead>
                <tr>
                  <Th>Lot</Th>
                  <Th>Product</Th>
                  <Th>Warehouse</Th>
                  <Th>Expires</Th>
                  <Th className="text-right">On hand</Th>
                  <Th className="text-right">Reserved</Th>
                  <Th className="text-right">Allocatable</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((batch) => (
                  <tr key={batch.id}>
                    <Td>
                      <Link
                        href={`/lots/${batch.id}`}
                        className="font-mono text-sm font-medium text-slate-900 hover:underline"
                      >
                        {batch.lotCode}
                      </Link>
                    </Td>
                    <Td>
                      <span className="text-sm text-slate-700">{batch.variant.productName}</span>
                      <span className="block font-mono text-xs text-slate-500">
                        {batch.variant.sku}
                      </span>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{batch.warehouse.code}</span>
                    </Td>
                    <Td>
                      {batch.expiresAt ? (
                        <Badge tone={batch.pastExpiry ? 'danger' : 'neutral'}>
                          {formatDate(batch.expiresAt)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-500">not stated</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{batch.quantityOnHand}</Td>
                    <Td className="text-right tabular-nums">{batch.quantityReserved}</Td>
                    <Td className="text-right tabular-nums">
                      {batch.quantityAllocatable === 0 && batch.quantityOnHand > 0 ? (
                        <Badge tone="warning">0</Badge>
                      ) : (
                        batch.quantityAllocatable
                      )}
                    </Td>
                    <Td>
                      <Badge tone={batchTone(batch.status)}>{humanise(batch.status)}</Badge>
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
