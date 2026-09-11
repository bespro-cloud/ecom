'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Adding a note to an order's timeline.
 *
 * The timeline is append-only — the database refuses updates and deletes on it
 * — so a note is permanent. That is the point: an order's history is evidence,
 * and evidence that can be tidied up afterwards is not evidence.
 *
 * Internal notes are for staff. A customer-visible note is shown to the person
 * who placed the order, which is why it is a deliberate choice rather than the
 * default.
 */
export function OrderNoteForm({ orderId, canWrite }: { orderId: string; canWrite: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [isInternal, setIsInternal] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canWrite) {
    return (
      <p className="text-sm text-slate-500">
        Adding notes needs the <code className="font-mono">ORDER_WRITE</code> permission.
      </p>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      await clientRequest(`/api/v1/admin/commerce/orders/${orderId}/notes`, {
        method: 'POST',
        body: { note: note.trim(), isInternal },
      });
      setNote('');
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError
          ? caught.message
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <TextareaField
        rows={3}
        label="Add a note"
        name="note"
        value={note}
        maxLength={2000}
        onChange={(event) => setNote(event.target.value)}
        hint="Appended to the timeline permanently. It cannot be edited or removed."
      />
      <Checkbox
        label="Internal only"
        name="isInternal"
        checked={isInternal}
        onChange={(event) => setIsInternal(event.target.checked)}
        hint="Untick to make this note visible to the customer."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button type="submit" size="sm" loading={saving} disabled={note.trim().length === 0}>
        Add note
      </Button>
    </form>
  );
}

/**
 * Cancelling an order.
 *
 * Cancelling releases the stock the order was holding, which is why it is worth
 * doing rather than leaving a dead order open. Refunding is offered alongside
 * because an order that took money and is then cancelled without a refund is
 * the worst of both — but it stays a separate, explicit decision.
 */
export function CancelOrderForm({
  orderId,
  canCancel,
  hasCapturedPayment,
}: {
  orderId: string;
  canCancel: boolean;
  hasCapturedPayment: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(hasCapturedPayment);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canCancel) {
    return (
      <p className="text-sm text-slate-500">
        Cancelling needs the <code className="font-mono">ORDER_CANCEL</code> permission.
      </p>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest(`/api/v1/admin/commerce/orders/${orderId}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim(), refund },
      });
      setConfirming(false);
      setReason('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Reload and check whether the order was cancelled.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Cancel this order
      </Button>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <Alert tone="warning" title="Cancelling cannot be undone">
        Reserved stock is released back to sellable. A cancelled order cannot be reopened; the
        customer would need to place a new one.
      </Alert>

      <TextareaField
        rows={3}
        label="Why is this order being cancelled?"
        name="reason"
        value={reason}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        error={
          fieldErrors.reason ??
          (reason.trim().length > 0 && reason.trim().length < 5
            ? 'At least 5 characters.'
            : undefined)
        }
        required
      />

      {hasCapturedPayment ? (
        <Checkbox
          label="Refund the captured payment as part of cancelling"
          name="refund"
          checked={refund}
          onChange={(event) => setRefund(event.target.checked)}
          hint="Leaving this unticked cancels the order but keeps the customer's money. Only do that if a refund is being handled another way."
        />
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex gap-2">
        <Button
          type="submit"
          variant="danger"
          size="sm"
          loading={saving}
          disabled={reason.trim().length < 5}
        >
          Cancel order
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
