import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, PageHeader } from '@health/ui';
import { ApiError } from '@/lib/api-client';
import { fetchMyThread } from '@/lib/lifecycle';
import { formatDateTime } from '@/lib/format';
import { SupportReplyForm } from '@/components/support-reply-form';

export const metadata: Metadata = { title: 'Conversation', robots: { index: false } };

const LABEL: Record<string, string> = {
  OPEN: 'With our team',
  AWAITING_CUSTOMER: 'Waiting for you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/**
 * One conversation.
 *
 * Everything shown came back from `findForCustomer`, which excludes internal
 * staff notes **in the query**. This page does no filtering of its own — a
 * `.filter()` in a component is one careless refactor away from showing staff
 * commentary to the person it is about.
 */
export default async function SupportThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let thread;
  try {
    thread = await fetchMyThread(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={thread.subject}
        description={`Reference ${thread.reference}`}
        actions={<Badge tone="info">{LABEL[thread.status] ?? thread.status}</Badge>}
      />

      <ol className="space-y-3">
        {thread.messages.map((message) => {
          const mine = message.authorType === 'CUSTOMER';
          return (
            <li key={message.id}>
              <Card className={mine ? 'bg-brand-50/40' : undefined}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">{message.author}</span>
                  <span className="text-sm text-slate-500">
                    {formatDateTime(message.createdAt)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                  {message.body}
                </p>
              </Card>
            </li>
          );
        })}
      </ol>

      <Card>
        <SupportReplyForm threadId={thread.id} closed={thread.status === 'CLOSED'} />
      </Card>

      <p className="text-sm">
        <Link href="/account/support" className="text-brand-700 hover:text-brand-800">
          Back to your conversations
        </Link>
      </p>
    </div>
  );
}
