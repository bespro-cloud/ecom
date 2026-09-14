import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { humanise, listThreads } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Support inbox' };

const TONE: Record<string, 'success' | 'warning' | 'neutral' | 'info'> = {
  OPEN: 'info',
  AWAITING_CUSTOMER: 'warning',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

export default async function SupportInboxPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'SUPPORT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="SUPPORT_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listThreads('limit=100');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Support inbox"
          description="Customer conversations. This inbox is not for clinical questions — the storefront says so before a customer types, and neither should a reply from here give clinical advice."
        />

        <Card>
          {data.length === 0 ? (
            <EmptyState title="Nothing waiting" description="Conversations appear here." />
          ) : (
            <TableShell caption="Conversations, most recently active first">
              <thead>
                <tr>
                  <Th>Reference</Th>
                  <Th>Subject</Th>
                  <Th>Topic</Th>
                  <Th>Customer</Th>
                  <Th>Order</Th>
                  <Th className="text-right">Messages</Th>
                  <Th>Last activity</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((thread) => (
                  <tr key={thread.id}>
                    <Td>
                      <Link
                        href={`/support/${thread.id}`}
                        className="font-mono text-sm font-medium text-slate-900 hover:underline"
                      >
                        {thread.reference}
                      </Link>
                    </Td>
                    <Td>{thread.subject}</Td>
                    <Td className="text-sm text-slate-600">{humanise(thread.topic)}</Td>
                    <Td className="font-mono text-sm">{thread.customerReference}</Td>
                    <Td className="font-mono text-sm">{thread.order?.reference ?? '—'}</Td>
                    <Td className="text-right tabular-nums">{thread.messageCount}</Td>
                    <Td className="text-sm">
                      {formatDate(thread.lastMessageAt ?? thread.createdAt)}
                    </Td>
                    <Td>
                      <Badge tone={TONE[thread.status] ?? 'neutral'}>
                        {humanise(thread.status)}
                      </Badge>
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
