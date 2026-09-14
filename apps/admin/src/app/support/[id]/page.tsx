import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { getThread, humanise } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';
import { formatDateTime, formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { SupportStaffReply } from '@/components/support-staff-reply';

export const metadata: Metadata = { title: 'Conversation' };

export default async function AdminThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'SUPPORT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="SUPPORT_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;
  const thread = await getThread(id);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={thread.subject}
          description={`${thread.reference} · ${humanise(thread.topic)} · customer ${thread.customer.reference}`}
          actions={<Badge tone="neutral">{humanise(thread.status)}</Badge>}
        />

        {thread.order ? (
          <Card>
            <p className="text-sm text-slate-700">
              About order{' '}
              <Link
                href={`/orders/${thread.order.id}`}
                className="font-mono font-medium text-brand-700 hover:text-brand-800"
              >
                {thread.order.reference}
              </Link>{' '}
              — {humanise(thread.order.status)}, {formatMoney(thread.order.totalCents)}
            </p>
          </Card>
        ) : null}

        <Alert tone="info" title="Not a clinical channel">
          <p>
            We cannot answer questions about a customer&rsquo;s health, medication or symptoms, and
            should not invite those details. Point them to their doctor or pharmacist instead.
          </p>
        </Alert>

        <ol className="space-y-3">
          {thread.messages.map((message) => (
            <li key={message.id}>
              <Card
                className={
                  message.isInternal
                    ? 'bg-amber-50 ring-amber-200'
                    : message.authorType === 'STAFF'
                      ? 'bg-slate-50'
                      : undefined
                }
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    {message.authorType === 'STAFF'
                      ? (message.authorLabel ?? 'Support')
                      : 'Customer'}
                    {message.isInternal ? (
                      <Badge tone="warning" className="ml-2">
                        Internal — not shown to the customer
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-sm text-slate-500">
                    {formatDateTime(message.createdAt)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                  {message.body}
                </p>
              </Card>
            </li>
          ))}
        </ol>

        {hasPermission(user, 'SUPPORT_WRITE') ? (
          <Card>
            <SupportStaffReply threadId={thread.id} status={thread.status} />
          </Card>
        ) : (
          <Alert tone="info" title="You can read this but not reply">
            <p>Replying needs the SUPPORT_WRITE permission.</p>
          </Alert>
        )}

        <p className="text-sm">
          <Link href="/support" className="text-brand-700 hover:text-brand-800">
            Back to the inbox
          </Link>
        </p>
      </div>
    </ConsoleShell>
  );
}
