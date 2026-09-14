import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { humanise, listErasureRequests } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { ErasureDecisionForm } from '@/components/erasure-decision-form';

export const metadata: Metadata = { title: 'Deletion requests' };

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  REQUESTED: 'warning',
  IN_REVIEW: 'warning',
  COMPLETED: 'success',
  REFUSED: 'danger',
};

/**
 * Deletion requests.
 *
 * Decided by a person, never automatically. A request that a queue processed on
 * its own would delete an account nobody checked — and some of these requests
 * have to be refused, because there are records the business is required to
 * keep.
 */
export default async function ErasureRequestsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'CUSTOMER_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="CUSTOMER_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listErasureRequests('limit=100');
  const open = data.filter(
    (request) => request.status === 'REQUESTED' || request.status === 'IN_REVIEW',
  );
  const canDecide = hasPermission(user, 'CUSTOMER_ERASE');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Deletion requests"
          description="Customers asking to have their account removed. Each one is decided by a person and the reasoning is recorded."
        />

        {open.length > 0 ? (
          <Alert tone="warning" title={`${open.length} request(s) waiting`}>
            These are legal requests with a response window. Decide them promptly, and say what was
            removed and what had to be kept.
          </Alert>
        ) : null}

        {data.length === 0 ? (
          <EmptyState
            title="No requests"
            description="Customers ask from the privacy screen in their account."
          />
        ) : (
          <ul className="space-y-4">
            {data.map((request) => (
              <li key={request.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-mono text-sm font-medium text-slate-900">
                        {request.customerReference}
                      </p>
                      <p className="text-sm text-slate-600">{request.customerEmail}</p>
                    </div>
                    <Badge tone={TONE[request.status] ?? 'neutral'}>
                      {humanise(request.status)}
                    </Badge>
                  </div>

                  <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-slate-500">Asked</dt>
                      <dd className="mt-0.5 text-slate-900">{formatDateTime(request.createdAt)}</dd>
                    </div>
                    {request.decidedAt ? (
                      <div>
                        <dt className="text-slate-500">Decided</dt>
                        <dd className="mt-0.5 text-slate-900">
                          {formatDateTime(request.decidedAt)} by{' '}
                          {request.decidedByLabel ?? 'unknown'}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {request.reason ? (
                    <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      &ldquo;{request.reason}&rdquo;
                    </p>
                  ) : null}

                  {request.status === 'REQUESTED' || request.status === 'IN_REVIEW' ? (
                    <div className="mt-4 border-t border-slate-200 pt-4">
                      <ErasureDecisionForm
                        requestId={request.id}
                        canDecide={canDecide}
                        mfaEnabled={user.mfaEnabled}
                      />
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ConsoleShell>
  );
}
