import type { Metadata } from 'next';
import { Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listWarehouses } from '@/lib/commerce';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { WarehouseForm } from '@/components/warehouse-form';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Warehouses' };

export default async function WarehousesPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'INVENTORY_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="INVENTORY_READ" />
      </ConsoleShell>
    );
  }

  const warehouses = await listWarehouses(true);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Warehouses"
          description="Where stock physically sits. Orders are allocated from active warehouses in priority order, and a product with no allocatable stock cannot be published."
        />

        <Card>
          {warehouses.length === 0 ? (
            <EmptyState
              title="No warehouses yet"
              description="Nothing can be allocated or shipped until there is at least one."
            />
          ) : (
            <TableShell caption="Warehouses">
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Location</Th>
                  <Th className="text-right">Priority</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {warehouses.map((warehouse) => (
                  <tr key={warehouse.id}>
                    <Td>
                      <span className="font-mono text-sm">{warehouse.code}</span>
                    </Td>
                    <Td>{warehouse.name}</Td>
                    <Td>
                      <span className="text-sm text-slate-700">
                        {warehouse.city}, {warehouse.region} {warehouse.postalCode}
                      </span>
                      <span className="block text-xs text-slate-500">{warehouse.line1}</span>
                    </Td>
                    <Td className="text-right tabular-nums">{warehouse.priority}</Td>
                    <Td>
                      <Badge tone={warehouse.isActive ? 'success' : 'neutral'}>
                        {warehouse.isActive ? 'active' : 'inactive'}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Add a warehouse</h2>
          <div className="mt-4">
            <WarehouseForm canManage={hasPermission(user, 'INVENTORY_ADJUST')} />
          </div>
        </Card>
      </div>
    </ConsoleShell>
  );
}
