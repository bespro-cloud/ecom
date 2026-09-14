import type { Metadata } from 'next';
import { Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listCoupons } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDate, formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { CouponForm } from '@/components/coupon-form';
import { CouponToggle } from '@/components/coupon-toggle';

export const metadata: Metadata = { title: 'Discount codes' };

function value(coupon: {
  type: string;
  amountCents: number | null;
  basisPoints: number | null;
}): string {
  if (coupon.type === 'FREE_SHIPPING') return 'Free delivery';
  if (coupon.type === 'PERCENTAGE' && coupon.basisPoints !== null) {
    return `${coupon.basisPoints / 100}% off`;
  }
  if (coupon.amountCents !== null) return `${formatMoney(coupon.amountCents)} off`;
  return '—';
}

export default async function CouponsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'COUPON_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="COUPON_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listCoupons('limit=100');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Discount codes"
          description="What a code is worth is recomputed at every repricing. A checkout can name a code; it can never name an amount."
        />

        <Card>
          {data.length === 0 ? (
            <EmptyState title="No codes yet" description="Create one below." />
          ) : (
            <TableShell caption="Discount codes, newest first">
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Value</Th>
                  <Th className="text-right">Used</Th>
                  <Th>Window</Th>
                  <Th>State</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {data.map((coupon) => (
                  <tr key={coupon.id}>
                    <Td>
                      <span className="font-mono text-sm font-medium text-slate-900">
                        {coupon.code}
                      </span>
                      {coupon.requiresCustomer ? (
                        <span className="block text-xs text-slate-500">Signed-in customers</span>
                      ) : null}
                    </Td>
                    <Td>{coupon.name}</Td>
                    <Td>
                      {value(coupon)}
                      {coupon.minSubtotalCents ? (
                        <span className="block text-xs text-slate-500">
                          over {formatMoney(coupon.minSubtotalCents)}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {coupon.redemptions}
                      {coupon.maxRedemptions !== null ? ` / ${coupon.maxRedemptions}` : ''}
                    </Td>
                    <Td className="text-sm text-slate-600">
                      {coupon.startsAt ? formatDate(coupon.startsAt) : 'now'} —{' '}
                      {coupon.endsAt ? formatDate(coupon.endsAt) : 'no end'}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={coupon.isActive ? 'success' : 'neutral'}>
                          {coupon.isActive ? 'On' : 'Off'}
                        </Badge>
                        {coupon.expired ? <Badge tone="warning">Expired</Badge> : null}
                        {coupon.exhausted ? <Badge tone="warning">Used up</Badge> : null}
                      </div>
                    </Td>
                    <Td>
                      {hasPermission(user, 'COUPON_WRITE') ? (
                        <CouponToggle couponId={coupon.id} isActive={coupon.isActive} />
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        {hasPermission(user, 'COUPON_WRITE') ? (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Create a code</h2>
            <p className="mt-1 max-w-prose text-sm text-slate-600">
              A percentage is rounded down when applied, never up. A usage limit is enforced by
              counting redemption rows under a lock, so two concurrent checkouts cannot both take
              the last remaining use.
            </p>
            <div className="mt-4">
              <CouponForm />
            </div>
          </Card>
        ) : null}
      </div>
    </ConsoleShell>
  );
}
