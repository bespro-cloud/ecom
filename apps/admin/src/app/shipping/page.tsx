import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listShippingRates } from '@/lib/commerce';
import { currentUser } from '@/lib/session';
import { formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { ShippingRateForm } from '@/components/shipping-rate-form';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Shipping' };

/**
 * Shipping rates.
 *
 * These are the only source of the shipping figure on an order. A checkout
 * re-quotes against them server-side before anything is charged, so a customer
 * who edits the request body gets the same number they were shown — or a
 * refusal, never a cheaper rate.
 */
export default async function ShippingPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'ORDER_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="ORDER_READ" />
      </ConsoleShell>
    );
  }

  const rates = await listShippingRates();
  const active = rates.filter((rate) => rate.isActive);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Shipping rates"
          description="What delivery costs, by destination. Quoted at checkout and recomputed before payment; the browser never supplies a shipping price."
        />

        {active.length === 0 ? (
          <Alert tone="warning" title="No active rate">
            Checkout cannot quote delivery without one, so no order can be completed. Add a rate
            covering the destinations you sell to.
          </Alert>
        ) : null}

        <Card>
          {rates.length === 0 ? (
            <EmptyState
              title="No rates configured"
              description="Add the delivery options customers should be able to choose from."
            />
          ) : (
            <TableShell caption="Shipping rates">
              <thead>
                <tr>
                  <Th>Rate</Th>
                  <Th>Destinations</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Free above</Th>
                  <Th>Estimate</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rates.map((rate) => (
                  <tr key={rate.id}>
                    <Td>
                      <span className="font-medium text-slate-900">{rate.name}</span>
                      <span className="block font-mono text-xs text-slate-500">{rate.code}</span>
                    </Td>
                    <Td>
                      <span className="text-sm text-slate-700">{rate.countries.join(', ')}</span>
                      {rate.regions.length > 0 ? (
                        <span className="block text-xs text-slate-500">
                          {rate.regions.join(', ')}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{formatMoney(rate.priceCents)}</Td>
                    <Td className="text-right tabular-nums">
                      {rate.freeAboveSubtotalCents === null
                        ? '—'
                        : formatMoney(rate.freeAboveSubtotalCents)}
                    </Td>
                    <Td>
                      {rate.estimatedDaysMin === null && rate.estimatedDaysMax === null
                        ? '—'
                        : `${rate.estimatedDaysMin ?? '?'}–${rate.estimatedDaysMax ?? '?'} days`}
                    </Td>
                    <Td>
                      <Badge tone={rate.isActive ? 'success' : 'neutral'}>
                        {rate.isActive ? 'active' : 'inactive'}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Add a rate</h2>
          <div className="mt-4">
            <ShippingRateForm canManage={hasPermission(user, 'SYSTEM_SETTINGS')} />
          </div>
        </Card>
      </div>
    </ConsoleShell>
  );
}
