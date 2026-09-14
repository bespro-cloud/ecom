import type { Metadata } from 'next';
import { Alert, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { fetchChannels, fetchOverview, fetchTopProducts, percent, humanise } from '@/lib/growth';
import { currentUser } from '@/lib/session';
import { formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Analytics' };

/**
 * The analytics dashboard.
 *
 * Everything on this page is a count of sessions or a figure from the orders
 * table. There is no per-visitor view, no "customer journey", and no way to ask
 * what any individual looked at — not because those screens were left for
 * later, but because the data to build them is not collected.
 *
 * The page says so, in the interface, rather than only in a design document.
 * Somebody will eventually ask why they cannot drill into a person, and the
 * answer should be on the screen.
 */
export default async function AnalyticsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'ANALYTICS_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="ANALYTICS_READ" />
      </ConsoleShell>
    );
  }

  const [overview, channels, products] = await Promise.all([
    fetchOverview(),
    fetchChannels(),
    fetchTopProducts(),
  ]);

  const empty = overview.totals.sessions === 0 && overview.totals.orders === 0;

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Analytics"
          description={`First-party measurement, ${overview.from} to ${overview.to}. Sessions come from the site; orders and revenue come from the orders table.`}
        />

        <Alert tone="info" title="What this can and cannot tell you">
          <p>
            These are aggregates. Nothing here is linked to a named customer, and nothing can be:
            analytics carries no customer id, no email and no IP address, visitor identifiers are
            re-salted every day so they cannot be followed across days, and raw events are deleted
            after 30 days.
          </p>
          <p className="mt-2">
            That is deliberate. On a site selling supplements, a record of who looked at what is a
            health inference about a person, and building one is the thing regulators have gone
            after health companies for.
          </p>
        </Alert>

        {empty ? (
          <EmptyState
            title="No measurements yet"
            description="Numbers appear once visitors have accepted analytics and the hourly rollup has run."
          />
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Sessions" value={overview.totals.sessions.toLocaleString()} />
          <Metric
            label="Visitors per day, summed"
            value={overview.totals.uniqueVisitors.toLocaleString()}
            note="Not de-duplicated across days — visitor ids are re-salted daily by design."
          />
          <Metric label="Orders" value={overview.totals.orders.toLocaleString()} />
          <Metric
            label="Revenue"
            value={formatMoney(overview.totals.revenueCents)}
            note="From the orders table, never from a browser."
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Metric label="Conversion rate" value={percent(overview.totals.conversionRate)} />
          <Metric
            label="Average order value"
            value={formatMoney(overview.totals.averageOrderValueCents)}
          />
        </div>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Funnel</h2>
          <p className="mt-1 text-sm text-slate-600">
            Sessions that reached each step. A session that ordered also reached every step above
            it.
          </p>
          <div className="mt-4">
            <TableShell caption="Purchase funnel">
              <thead>
                <tr>
                  <Th>Step</Th>
                  <Th className="text-right">Sessions</Th>
                  <Th className="text-right">From previous</Th>
                  <Th className="text-right">Of all sessions</Th>
                </tr>
              </thead>
              <tbody>
                {overview.funnel.map((stage) => (
                  <tr key={stage.step}>
                    <Td>{humanise(stage.step)}</Td>
                    <Td className="text-right tabular-nums">{stage.sessions.toLocaleString()}</Td>
                    <Td className="text-right tabular-nums">
                      {stage.continuationRate === null ? '—' : percent(stage.continuationRate)}
                    </Td>
                    <Td className="text-right tabular-nums">{percent(stage.overallRate)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Channels</h2>
          <p className="mt-1 text-sm text-slate-600">
            Sessions from analytics, orders and revenue from the orders table, joined on a campaign
            label and a day — never on a person.
          </p>
          {channels.length === 0 ? (
            <p className="mt-4 text-sm text-slate-600">Nothing recorded for this range.</p>
          ) : (
            <div className="mt-4">
              <TableShell caption="Acquisition channels">
                <thead>
                  <tr>
                    <Th>Channel</Th>
                    <Th className="text-right">Sessions</Th>
                    <Th className="text-right">Orders</Th>
                    <Th className="text-right">Conversion</Th>
                    <Th className="text-right">Revenue</Th>
                    <Th className="text-right">Per session</Th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((row) => (
                    <tr key={row.channel}>
                      <Td>{row.channel}</Td>
                      <Td className="text-right tabular-nums">{row.sessions.toLocaleString()}</Td>
                      <Td className="text-right tabular-nums">{row.orders.toLocaleString()}</Td>
                      <Td className="text-right tabular-nums">{percent(row.conversionRate)}</Td>
                      <Td className="text-right tabular-nums">{formatMoney(row.revenueCents)}</Td>
                      <Td className="text-right tabular-nums">
                        {formatMoney(row.revenuePerSessionCents)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Products</h2>
          <p className="mt-1 text-sm text-slate-600">
            Counts of events, never a list of who. Units and money come from order items.
          </p>
          {products.length === 0 ? (
            <p className="mt-4 text-sm text-slate-600">Nothing recorded for this range.</p>
          ) : (
            <div className="mt-4">
              <TableShell caption="Products by revenue">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th className="text-right">Views</Th>
                    <Th className="text-right">Added to basket</Th>
                    <Th className="text-right">Rate</Th>
                    <Th className="text-right">Units</Th>
                    <Th className="text-right">Revenue</Th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((row) => (
                    <tr key={row.productId}>
                      <Td>{row.productName}</Td>
                      <Td className="text-right tabular-nums">{row.views.toLocaleString()}</Td>
                      <Td className="text-right tabular-nums">{row.addToCarts.toLocaleString()}</Td>
                      <Td className="text-right tabular-nums">{percent(row.addToCartRate)}</Td>
                      <Td className="text-right tabular-nums">
                        {row.unitsOrdered.toLocaleString()}
                      </Td>
                      <Td className="text-right tabular-nums">{formatMoney(row.revenueCents)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </div>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}
    </Card>
  );
}
