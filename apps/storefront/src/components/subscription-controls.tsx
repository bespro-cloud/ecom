'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';
import type { PaymentMethodView, SubscriptionView } from '@/lib/lifecycle';

type Action = 'pause' | 'resume' | 'cancel' | null;

/**
 * Pause, resume, change card, cancel.
 *
 * Cancelling is one button and a confirmation. There is no retention offer, no
 * required reason and no "call us to cancel" — each of those is a dark pattern
 * the FTC has been explicit about, and the API would not enforce them anyway.
 * The reason box is there because some people want to say why, not because
 * anyone has to.
 */
export function SubscriptionControls({
  subscription,
  paymentMethods,
}: {
  subscription: SubscriptionView;
  paymentMethods: PaymentMethodView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Action>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardId, setCardId] = useState(subscription.paymentMethod?.id ?? '');

  const live = subscription.status !== 'CANCELLED' && subscription.status !== 'UNPAID';

  async function act(path: string, body?: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientRequest(`/api/v1/account/subscriptions/${subscription.id}${path}`, {
        method: path === '' ? 'PATCH' : 'POST',
        body: body ?? {},
      });
      setOpen(null);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError
          ? caught.message
          : 'We could not make that change. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!live) return null;

  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      {error ? (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {open === null ? (
        <div className="flex flex-wrap gap-2">
          {subscription.status === 'PAUSED' ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => void act('/resume')}
              loadingLabel="Resuming…"
            >
              Resume deliveries
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setOpen('pause')}>
              Pause deliveries
            </Button>
          )}
          <Button variant="ghost" onClick={() => setOpen('cancel')}>
            Cancel subscription
          </Button>
        </div>
      ) : null}

      {open === 'pause' ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Pausing stops the next charge and the next delivery. Nothing is billed while paused, and
            you can resume whenever you like.
          </p>
          <TextareaField
            label="Anything you want to tell us? (optional)"
            rows={3}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              loading={busy}
              loadingLabel="Pausing…"
              onClick={() => void act('/pause', reason.trim() ? { reason: reason.trim() } : {})}
            >
              Pause
            </Button>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Keep it running
            </Button>
          </div>
        </div>
      ) : null}

      {open === 'cancel' ? (
        <div className="space-y-3">
          <Alert tone="warning" title="This cancels the subscription straight away">
            <p>
              You will not be charged again. Anything already dispatched is unaffected, and you can
              start a new subscription at any time.
            </p>
          </Alert>
          <TextareaField
            label="Why are you cancelling? (optional)"
            hint="You do not have to answer. It helps us, but it is not a condition of cancelling."
            rows={3}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              loading={busy}
              loadingLabel="Cancelling…"
              onClick={() => void act('/cancel', reason.trim() ? { reason: reason.trim() } : {})}
            >
              Cancel subscription
            </Button>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      {paymentMethods.length > 1 && open === null ? (
        <div className="mt-4 max-w-sm space-y-2">
          <SelectField
            label="Card this bills to"
            value={cardId}
            onChange={(event) => setCardId(event.target.value)}
          >
            {paymentMethods.map((method) => (
              <option key={method.id} value={method.id}>
                {method.cardBrand ?? 'Card'} ending {method.cardLast4 ?? '????'}
              </option>
            ))}
          </SelectField>
          {cardId !== subscription.paymentMethod?.id ? (
            <Button
              variant="secondary"
              loading={busy}
              loadingLabel="Saving…"
              onClick={() => void act('', { paymentMethodId: cardId })}
            >
              Use this card
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
