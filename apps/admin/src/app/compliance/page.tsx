import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listExpiringApprovals, listProducts } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Compliance' };

/**
 * The compliance reviewer's queue.
 *
 * Two lists, both of which exist so a problem is noticed rather than
 * discovered: listings waiting for a decision, and approvals that have lapsed
 * or are about to. An approval nobody re-reviewed is how a live listing ends up
 * resting on evidence that has since been superseded.
 */
export default async function CompliancePage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'COMPLIANCE_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="COMPLIANCE_READ" />
      </ConsoleShell>
    );
  }

  const [waiting, expiring] = await Promise.all([
    listProducts('complianceStatus=NOT_REVIEWED&limit=50'),
    listExpiringApprovals(30),
  ]);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Compliance"
          description="Listings waiting for a decision, and approvals that are lapsing. A decision is a named person's statement that they checked a listing against the documentation held for it."
        />

        {!hasPermission(user, 'COMPLIANCE_APPROVE') ? (
          <Alert tone="info">
            You can read this queue but not record decisions — that needs{' '}
            <code className="font-mono">COMPLIANCE_APPROVE</code>.
          </Alert>
        ) : null}

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Waiting for review</h2>
          {waiting.data.length === 0 ? (
            <EmptyState
              title="Nothing is waiting"
              description="Every product has a recorded compliance decision."
            />
          ) : (
            <div className="mt-4">
              <TableShell caption="Products with no compliance decision">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Status</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {waiting.data.map((product) => (
                    <tr key={product.id}>
                      <Td>
                        <Link
                          href={`/compliance/${product.id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {product.name}
                        </Link>
                        <span className="block font-mono text-xs text-slate-500">
                          {product.sku}
                        </span>
                      </Td>
                      <Td>
                        <Badge>{product.status.toLowerCase().replace(/_/g, ' ')}</Badge>
                      </Td>
                      <Td>{formatDateTime(product.updatedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Approvals lapsing</h2>
          <p className="mt-1 text-sm text-slate-600">
            Within the next 30 days, or already expired. An expired approval blocks publication and
            takes effect on the next publish attempt.
          </p>
          {expiring.length === 0 ? (
            <EmptyState
              title="Nothing lapsing"
              description="No approved listing is due for re-review in the next 30 days."
            />
          ) : (
            <div className="mt-4">
              <TableShell caption="Approvals due for re-review">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Status</Th>
                    <Th>Due</Th>
                  </tr>
                </thead>
                <tbody>
                  {expiring.map((product) => {
                    const overdue = new Date(product.reviewDueAt).getTime() <= Date.now();
                    return (
                      <tr key={product.id}>
                        <Td>
                          <Link
                            href={`/compliance/${product.id}`}
                            className="font-medium text-slate-900 hover:underline"
                          >
                            {product.name}
                          </Link>
                          <span className="block font-mono text-xs text-slate-500">
                            {product.sku}
                          </span>
                        </Td>
                        <Td>
                          <Badge tone={product.status === 'PUBLISHED' ? 'success' : 'neutral'}>
                            {product.status.toLowerCase().replace(/_/g, ' ')}
                          </Badge>
                        </Td>
                        <Td>
                          <Badge tone={overdue ? 'danger' : 'warning'}>
                            {overdue ? 'overdue' : formatDateTime(product.reviewDueAt)}
                          </Badge>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            </div>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}
