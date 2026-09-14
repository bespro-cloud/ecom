import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { humanise, listRecalls, recallTone } from '@/lib/compliance';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Recalls' };

export default async function RecallsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'RECALL_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="RECALL_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listRecalls('limit=100');
  const open = data.filter(
    (recall) => recall.status === 'OPEN' || recall.status === 'NOTIFICATION_APPROVED',
  );

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Recalls"
          description="Opening a recall withdraws the affected lots from sale immediately. Contacting customers is a separate, recorded approval — this system sends nothing on its own."
        />

        {open.length > 0 ? (
          <Alert tone="error" title={`${open.length} recall(s) are live`}>
            Affected lots are not allocatable. Check whether customer contact has been approved and
            whether a regulator has been told.
          </Alert>
        ) : null}

        <Card>
          {data.length === 0 ? (
            <EmptyState
              title="No recalls"
              description="A recall is drafted against specific lots, then opened."
            />
          ) : (
            <TableShell caption="Recalls, most recent first">
              <thead>
                <tr>
                  <Th>Reference</Th>
                  <Th>Title</Th>
                  <Th>Class</Th>
                  <Th className="text-right">Lots</Th>
                  <Th>Status</Th>
                  <Th>Customer contact</Th>
                  <Th>Opened</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((recall) => (
                  <tr key={recall.id}>
                    <Td>
                      <Link
                        href={`/recalls/${recall.id}`}
                        className="font-mono text-sm font-medium text-slate-900 hover:underline"
                      >
                        {recall.reference}
                      </Link>
                    </Td>
                    <Td>{recall.title}</Td>
                    <Td>
                      <span className="text-xs text-slate-600">
                        {humanise(recall.classification)}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">{recall.lotCount}</Td>
                    <Td>
                      <Badge tone={recallTone(recall.status)}>{humanise(recall.status)}</Badge>
                    </Td>
                    <Td>
                      {recall.notificationApprovedAt ? (
                        <Badge tone="warning">approved</Badge>
                      ) : (
                        <span className="text-xs text-slate-500">not approved</span>
                      )}
                    </Td>
                    <Td>{recall.openedAt ? formatDate(recall.openedAt) : '—'}</Td>
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
