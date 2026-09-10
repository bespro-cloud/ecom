import type { Metadata } from 'next';
import { Alert, Badge, PageHeader, TableShell, Td, Th } from '@health/ui';
import type { Paginated } from '@health/types';
import { apiRequestOrSignIn } from '@/lib/guards';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { AuditFilters } from '@/components/audit-filters';

export const metadata: Metadata = { title: 'Audit log' };

interface AuditRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  correlationId: string | null;
  createdAt: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; outcome?: string; entityType?: string }>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'AUDIT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="AUDIT_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '50' });
  if (params.action) query.set('action', params.action);
  if (params.outcome) query.set('outcome', params.outcome);
  if (params.entityType) query.set('entityType', params.entityType);

  const page = await apiRequestOrSignIn<Paginated<AuditRow>>(
    `/api/v1/audit-logs?${query.toString()}`,
  );

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Audit log"
          description="Append-only. The database rejects updates and deletes on this table, so what is here is what happened."
        />

        <Alert tone="info">
          Email addresses and network locations are recorded in reduced form — enough to investigate
          an incident, not enough to build a tracking record.
        </Alert>

        <AuditFilters
          current={{
            action: params.action ?? '',
            outcome: params.outcome ?? '',
            entityType: params.entityType ?? '',
          }}
        />

        <TableShell caption="Audit records, newest first">
          <thead className="bg-slate-50">
            <tr>
              <Th>When</Th>
              <Th>Action</Th>
              <Th>Actor</Th>
              <Th>Entity</Th>
              <Th>Outcome</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {page.data.map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap text-xs">
                  <time dateTime={row.createdAt}>{formatDateTime(row.createdAt)}</time>
                </Td>
                <Td className="font-mono text-xs">{row.action}</Td>
                <Td className="text-xs">
                  <span className="block">{row.actorLabel ?? row.actorType}</span>
                  {row.ipAddress ? (
                    <span className="block font-mono text-slate-400">{row.ipAddress}</span>
                  ) : null}
                </Td>
                <Td className="text-xs">
                  <span className="block">{row.entityType}</span>
                  {row.entityId ? (
                    <span className="block font-mono text-slate-400">
                      {row.entityId.slice(0, 8)}…
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={row.outcome === 'SUCCESS' ? 'success' : 'danger'}>
                    {row.outcome}
                  </Badge>
                </Td>
                <Td className="max-w-sm text-xs">
                  {row.reason ? <p className="text-slate-700">{row.reason}</p> : null}
                  {row.before || row.after ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-brand-700">Before / after</summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-tight text-slate-700">
                        {JSON.stringify({ before: row.before, after: row.after }, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                  {row.correlationId ? (
                    <span className="mt-1 block font-mono text-[11px] text-slate-400">
                      {row.correlationId}
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
            {page.data.length === 0 ? (
              <tr>
                <Td className="py-8 text-center text-slate-500">
                  No audit records match this filter.
                </Td>
              </tr>
            ) : null}
          </tbody>
        </TableShell>

        <p className="text-sm text-slate-500">
          Showing {page.meta.count} record{page.meta.count === 1 ? '' : 's'}
          {page.meta.nextCursor ? ' (more available)' : ''}.
        </p>
      </div>
    </ConsoleShell>
  );
}
