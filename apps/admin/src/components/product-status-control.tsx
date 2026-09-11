'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Moving a product between statuses.
 *
 * Two things this component deliberately does *not* do.
 *
 * It does not decide whether publication is allowed. It sends the request and
 * reports what the server said. The gate is evaluated server-side at the
 * transition, and a screen that pre-judged it would eventually disagree with
 * the server — at which point the person would trust the screen.
 *
 * It does not let a live listing be withdrawn without a reason. The API
 * requires one; asking for it here means the person writes it while they know
 * why, rather than discovering the requirement as a validation error.
 */

const TRANSITIONS: Record<
  string,
  Array<{ to: string; label: string; tone: 'primary' | 'quiet' }>
> = {
  DRAFT: [
    { to: 'IN_REVIEW', label: 'Send for review', tone: 'primary' },
    { to: 'ARCHIVED', label: 'Archive', tone: 'quiet' },
  ],
  IN_REVIEW: [
    { to: 'READY', label: 'Mark ready', tone: 'primary' },
    { to: 'DRAFT', label: 'Back to draft', tone: 'quiet' },
    { to: 'ARCHIVED', label: 'Archive', tone: 'quiet' },
  ],
  READY: [
    { to: 'PUBLISHED', label: 'Publish', tone: 'primary' },
    { to: 'DRAFT', label: 'Back to draft', tone: 'quiet' },
    { to: 'ARCHIVED', label: 'Archive', tone: 'quiet' },
  ],
  PUBLISHED: [
    { to: 'DRAFT', label: 'Take out of sale', tone: 'quiet' },
    { to: 'ARCHIVED', label: 'Archive', tone: 'quiet' },
  ],
  ARCHIVED: [{ to: 'DRAFT', label: 'Restore as draft', tone: 'quiet' }],
};

export function ProductStatusControl({
  productId,
  status,
  canPublish,
}: {
  productId: string;
  status: string;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Array<{ path: string; message: string }> | null>(null);

  const available = TRANSITIONS[status] ?? [];
  const leavingSale = status === 'PUBLISHED';

  if (!canPublish) {
    return (
      <Alert tone="info" title="You cannot change this product’s status">
        Changing what customers can see needs the <code className="font-mono">PRODUCT_PUBLISH</code>{' '}
        permission. Writing product copy and publishing it are deliberately separate.
      </Alert>
    );
  }

  async function change(to: string): Promise<void> {
    setError(null);
    setBlocked(null);
    setPending(to);

    try {
      await clientRequest(`/api/v1/admin/catalogue/products/${productId}/status`, {
        method: 'PUT',
        body: { status: to, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      });
      setReason('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        // A refusal from the gate comes back as field-level details keyed by
        // the check that failed. Showing them beats a generic message.
        if (caught.code === 'PRECONDITION_FAILED' && caught.details?.length) {
          setBlocked(caught.details);
        } else {
          setError(caught.message);
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {leavingSale ? (
        <div>
          <label htmlFor="status-reason" className="block text-sm font-medium text-slate-700">
            Why is this coming out of sale?
          </label>
          <textarea
            id="status-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Recorded in the audit log. A supplier recall, a label correction, a stock decision…"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {available.map((transition) => (
          <Button
            key={transition.to}
            variant={transition.tone === 'primary' ? 'primary' : 'secondary'}
            disabled={pending !== null || (leavingSale && reason.trim().length === 0)}
            onClick={() => void change(transition.to)}
          >
            {pending === transition.to ? 'Working…' : transition.label}
          </Button>
        ))}
      </div>

      {blocked ? (
        <Alert tone="error" title="The checklist refused this">
          <p>These checks are not satisfied:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {blocked.map((detail) => (
              <li key={detail.path}>
                <span className="font-medium">{detail.path.toLowerCase().replace(/_/g, ' ')}</span>:{' '}
                {detail.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
