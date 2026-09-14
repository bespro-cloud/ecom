import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { fetchMyThreads } from '@/lib/lifecycle';
import { formatDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Support', robots: { index: false } };

const TONE: Record<string, 'success' | 'warning' | 'neutral' | 'info'> = {
  OPEN: 'info',
  AWAITING_CUSTOMER: 'warning',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

const LABEL: Record<string, string> = {
  OPEN: 'With our team',
  AWAITING_CUSTOMER: 'Waiting for you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

const TOPIC: Record<string, string> = {
  ORDER: 'An order',
  DELIVERY: 'Delivery',
  RETURN_OR_REFUND: 'A return or refund',
  PRODUCT_QUESTION: 'A product question',
  SUBSCRIPTION: 'A subscription',
  ACCOUNT: 'Account',
  OTHER: 'Something else',
};

export default async function SupportPage() {
  const threads = await fetchMyThreads();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support"
        description="Your conversations with our team."
        actions={
          <Link
            href="/account/support/new"
            className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Start a conversation
          </Link>
        }
      />

      {threads.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="If something is wrong with an order or a subscription, tell us here."
          action={
            <Link href="/account/support/new" className="text-sm font-medium text-brand-700">
              Start a conversation
            </Link>
          }
        />
      ) : (
        <ul className="space-y-3">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Link href={`/account/support/${thread.id}`} className="block">
                <Card className="transition-colors hover:bg-slate-50">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-base font-semibold text-slate-900">{thread.subject}</h2>
                    <Badge tone={TONE[thread.status] ?? 'neutral'}>
                      {LABEL[thread.status] ?? thread.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {TOPIC[thread.topic] ?? thread.topic}
                    {thread.order ? ` · order ${thread.order.reference}` : ''}
                    {' · '}
                    <span className="font-mono">{thread.reference}</span>
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Last message {formatDate(thread.lastMessageAt ?? thread.createdAt)}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
