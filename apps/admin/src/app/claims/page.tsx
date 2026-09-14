import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { claimTone, humanise, listClaims } from '@/lib/compliance';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Claims' };

/**
 * The claims queue.
 *
 * Two columns carry most of the meaning. **Approved wording** is what a
 * customer actually sees, and it is shown separately from the current draft
 * because the two are frequently different — a claim being reworded still shows
 * its old, approved text on the live listing. **Review due** is when the
 * approval lapses; an overdue claim has already stopped rendering.
 */
export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'CLAIM_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="CLAIM_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const single = (key: string): string => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  const query = new URLSearchParams();
  if (single('status')) query.set('status', single('status'));
  if (single('type')) query.set('type', single('type'));
  query.set('limit', '100');

  const { data } = await listClaims(query.toString());
  const canApprove = hasPermission(user, 'CLAIM_APPROVE');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Claims"
          description="Every statement recorded about a product, and where it stands. Only an approved claim appears on a listing, and only in the wording that was approved."
        />

        {!canApprove ? (
          <Alert tone="info">
            You can read and draft claims but not decide them — that needs{' '}
            <code className="font-mono">CLAIM_APPROVE</code>, which is held by compliance reviewers.
            The person who writes a health claim is deliberately not the person who signs it off.
          </Alert>
        ) : null}

        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="claim-status" className="block text-sm font-medium text-slate-700">
                Status
              </label>
              <select
                id="claim-status"
                name="status"
                defaultValue={single('status')}
                className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                <option value="">Any</option>
                {[
                  'DRAFT',
                  'EVIDENCE_REQUIRED',
                  'UNDER_REVIEW',
                  'APPROVED',
                  'REJECTED',
                  'EXPIRED',
                  'WITHDRAWN',
                ].map((status) => (
                  <option key={status} value={status}>
                    {humanise(status)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="claim-type" className="block text-sm font-medium text-slate-700">
                Type
              </label>
              <select
                id="claim-type"
                name="type"
                defaultValue={single('type')}
                className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                <option value="">Any</option>
                {[
                  'STRUCTURE_FUNCTION',
                  'NUTRIENT_CONTENT',
                  'HEALTH_CLAIM',
                  'DISEASE',
                  'GENERAL',
                ].map((type) => (
                  <option key={type} value={type}>
                    {humanise(type)}
                  </option>
                ))}
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
              title="No claims match"
              description="Claims are recorded against a product from its catalogue page."
            />
          ) : (
            <TableShell caption="Recorded product claims">
              <thead>
                <tr>
                  <Th>Claim</Th>
                  <Th>Product</Th>
                  <Th>Type</Th>
                  <Th>Status</Th>
                  <Th>On the listing</Th>
                  <Th>Review due</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((claim) => (
                  <tr key={claim.id}>
                    <Td>
                      <Link
                        href={`/claims/${claim.id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {claim.currentText ?? '(no wording)'}
                      </Link>
                      {claim.hasUnapprovedChanges ? (
                        <span className="mt-1 block text-xs text-amber-700">
                          Reworded since approval — the listing still shows the approved version.
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="text-sm text-slate-700">{claim.product?.name ?? '—'}</span>
                      <span className="block font-mono text-xs text-slate-500">
                        {claim.product?.sku}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-xs text-slate-600">{humanise(claim.type)}</span>
                    </Td>
                    <Td>
                      <Badge tone={claimTone(claim.status)}>{humanise(claim.status)}</Badge>
                    </Td>
                    <Td>
                      {claim.approvedText ? (
                        <span className="text-sm text-slate-700">{claim.approvedText}</span>
                      ) : (
                        <span className="text-xs text-slate-500">Nothing — never approved</span>
                      )}
                    </Td>
                    <Td>
                      {claim.reviewDueAt ? (
                        <Badge tone={claim.reviewOverdue ? 'danger' : 'neutral'}>
                          {claim.reviewOverdue ? 'lapsed' : formatDate(claim.reviewDueAt)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
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
