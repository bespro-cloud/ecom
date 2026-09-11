import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listStock, listWarehouses } from '@/lib/commerce';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { StockAdjustForm } from '@/components/stock-adjust-form';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Inventory' };

/**
 * Stock levels.
 *
 * Three numbers, kept distinct because conflating them is how a shop oversells:
 * **on hand** is what is physically in the warehouse, **reserved** is what is
 * already promised to open orders, and **available** is the difference — the
 * only one a customer can buy against.
 *
 * Stock leaves on-hand at fulfilment, not at checkout. An order that has been
 * paid for but not yet shipped still shows its units as on hand and reserved,
 * which is what the warehouse shelf actually looks like.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'INVENTORY_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="INVENTORY_READ" />
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
  if (single('warehouseId')) query.set('warehouseId', single('warehouseId'));
  if (single('lowStockOnly')) query.set('lowStockOnly', 'true');
  query.set('limit', '100');

  const [stock, warehouses] = await Promise.all([
    listStock(query.toString()),
    listWarehouses(false),
  ]);

  const canAdjust = hasPermission(user, 'INVENTORY_ADJUST');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Inventory"
          description="On hand is what is in the warehouse. Reserved is what open orders have already claimed. Available is what anyone can still buy."
        />

        {warehouses.length === 0 ? (
          <Alert tone="warning" title="No active warehouse">
            Stock cannot be allocated without one, and products with no allocatable stock cannot be
            published. Add a warehouse first.
          </Alert>
        ) : null}

        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="stock-search" className="block text-sm font-medium text-slate-700">
                Search
              </label>
              <input
                id="stock-search"
                type="search"
                name="search"
                defaultValue={single('search')}
                placeholder="SKU, variant or product name"
                maxLength={200}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>

            <div>
              <label htmlFor="stock-warehouse" className="block text-sm font-medium text-slate-700">
                Warehouse
              </label>
              <select
                id="stock-warehouse"
                name="warehouseId"
                defaultValue={single('warehouseId')}
                className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                <option value="">All</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.code} — {warehouse.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="lowStockOnly"
                value="true"
                defaultChecked={Boolean(single('lowStockOnly'))}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              At or below reorder point
            </label>

            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Apply
            </button>
          </form>
        </Card>

        <Card>
          {stock.data.length === 0 ? (
            <EmptyState
              title="No stock records match"
              description="A variant needs a stock record in an active warehouse before it can be sold."
            />
          ) : (
            <>
              <TableShell caption="Stock by variant and warehouse">
                <thead>
                  <tr>
                    <Th>Variant</Th>
                    <Th>Warehouse</Th>
                    <Th className="text-right">On hand</Th>
                    <Th className="text-right">Reserved</Th>
                    <Th className="text-right">Available</Th>
                    <Th className="text-right">Reorder at</Th>
                    <Th>Policy</Th>
                    {canAdjust ? <Th>Adjust</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {stock.data.map((row) => (
                    <tr key={row.id}>
                      <Td>
                        <span className="font-medium text-slate-900">{row.productName}</span>
                        <span className="block text-xs text-slate-500">{row.variantName}</span>
                        <span className="block font-mono text-xs text-slate-500">{row.sku}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs">{row.warehouse.code}</span>
                      </Td>
                      <Td className="text-right tabular-nums">{row.onHandQuantity}</Td>
                      <Td className="text-right tabular-nums">{row.reservedQuantity}</Td>
                      <Td className="text-right tabular-nums">
                        {row.isLow ? (
                          <Badge tone="warning">{row.availableQuantity}</Badge>
                        ) : (
                          row.availableQuantity
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">{row.reorderPoint}</Td>
                      <Td>
                        {!row.trackInventory ? <Badge>untracked</Badge> : null}
                        {row.allowBackorder ? <Badge tone="info">backorder</Badge> : null}
                        {row.trackInventory && !row.allowBackorder ? (
                          <span className="text-xs text-slate-500">tracked</span>
                        ) : null}
                      </Td>
                      {canAdjust ? (
                        <Td>
                          <StockAdjustForm row={row} canAdjust={canAdjust} />
                        </Td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </TableShell>

              {stock.meta.hasMore ? (
                <p className="mt-4 text-sm text-slate-500">
                  More rows match than are shown. Narrow the search or pick a warehouse.
                </p>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}
