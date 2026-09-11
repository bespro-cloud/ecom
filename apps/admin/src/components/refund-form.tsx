'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';
import { formatMoney } from '@/lib/format';
import type { AdminOrderItem } from '@/lib/commerce';

/**
 * Issuing a refund.
 *
 * Everything here is a *request*, not an instruction. The API recomputes the
 * refundable amount from the order's own stored line totals and what the
 * provider says is still captured, and refuses anything above it. Nothing this
 * form sends can widen that ceiling — the amount box exists because a partial
 * refund is a human decision, not because the client is trusted with money.
 *
 * Three things are deliberate:
 *
 * - **An idempotency key is generated once per mounted form.** A double-clicked
 *   button, a retried request or a flaky connection reuses the same key, and
 *   the API returns the first refund rather than issuing a second. It is
 *   regenerated only after a refund succeeds, so the next refund is a new one.
 * - **Notes are required and permanent.** A refund with no stated reason is not
 *   auditable, and this is money leaving the business.
 * - **Restocking is opt-in.** Returning units to sellable stock before anyone
 *   has seen them come back is how a warehouse promises goods it does not have.
 */

const NOTES_MIN = 10;

const REASONS = [
  ['REQUESTED_BY_CUSTOMER', 'Customer asked for a refund'],
  ['DAMAGED', 'Arrived damaged'],
  ['NOT_AS_DESCRIBED', 'Not as described'],
  ['LOST_IN_TRANSIT', 'Lost in transit'],
  ['FRAUDULENT', 'Fraudulent order'],
  ['DUPLICATE', 'Duplicate charge'],
  ['GOODWILL', 'Goodwill'],
  ['OTHER', 'Other — explain below'],
] as const;

function newIdempotencyKey(): string {
  return `refund-${crypto.randomUUID()}`;
}

export function RefundForm({
  orderId,
  currency,
  refundableCents,
  items,
  canRefund,
  mfaEnabled,
}: {
  orderId: string;
  currency: string;
  refundableCents: number;
  items: AdminOrderItem[];
  canRefund: boolean;
  mfaEnabled: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'amount' | 'lines'>('lines');
  const [amount, setAmount] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<string>('REQUESTED_BY_CUSTOMER');
  const [notes, setNotes] = useState('');
  const [restock, setRestock] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const refundableItems = useMemo(
    () => items.filter((item) => item.quantity - item.quantityRefunded > 0),
    [items],
  );

  // An estimate, shown so the operator can sanity-check before submitting. The
  // number that is actually refunded is the one the server computes.
  const estimatedCents = useMemo(() => {
    if (mode === 'amount') return Math.round(Number.parseFloat(amount || '0') * 100);
    return refundableItems.reduce((sum, item) => {
      const quantity = quantities[item.id] ?? 0;
      if (quantity <= 0) return sum;
      return sum + Math.round((item.lineTotalCents / item.quantity) * quantity);
    }, 0);
  }, [mode, amount, quantities, refundableItems]);

  if (refundableCents <= 0) {
    return (
      <Alert tone="info" title="Nothing left to refund">
        Every cent captured against this order has already been refunded.
      </Alert>
    );
  }

  if (!canRefund) {
    return (
      <Alert tone="info" title="You cannot issue refunds">
        <p>
          This needs the <code className="font-mono">REFUND_ISSUE</code> permission. Reading an
          order and giving money back are separate authorities on purpose.
        </p>
      </Alert>
    );
  }

  if (!mfaEnabled) {
    return (
      <Alert tone="warning" title="Enrol a second factor first">
        <p>
          Issuing a refund moves money out of the business, so it requires multi-factor
          authentication. Enrol a second factor and sign in again.
        </p>
        <p className="mt-2">
          The API enforces this regardless of what this screen shows — hiding the form is a
          courtesy, not the control.
        </p>
      </Alert>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    const lines = refundableItems
      .map((item) => ({ orderItemId: item.id, quantity: quantities[item.id] ?? 0 }))
      .filter((line) => line.quantity > 0);

    try {
      await clientRequest(`/api/v1/admin/commerce/orders/${orderId}/refunds`, {
        method: 'POST',
        body: {
          idempotencyKey,
          ...(mode === 'amount'
            ? { amountCents: Math.round(Number.parseFloat(amount || '0') * 100) }
            : { lines }),
          reason,
          notes: notes.trim(),
          restock,
        },
      });

      setAmount('');
      setQuantities({});
      setNotes('');
      setRestock(false);
      // A fresh key, so the next refund is genuinely a new one rather than
      // colliding with the one just issued.
      setIdempotencyKey(newIdempotencyKey());
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. The refund may not have been issued — reload and check.');
      }
    } finally {
      setSaving(false);
    }
  }

  const nothingChosen = estimatedCents <= 0;
  const overCeiling = estimatedCents > refundableCents;

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <p className="text-sm text-slate-600">
        Up to <strong>{formatMoney(refundableCents, currency)}</strong> remains refundable against
        this order.
      </p>

      <fieldset>
        <legend className="text-sm font-medium text-slate-700">What are you refunding?</legend>
        <div className="mt-2 flex gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="refund-mode"
              value="lines"
              checked={mode === 'lines'}
              onChange={() => setMode('lines')}
              className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Specific items
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="refund-mode"
              value="amount"
              checked={mode === 'amount'}
              onChange={() => setMode('amount')}
              className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            An amount
          </label>
        </div>
      </fieldset>

      {mode === 'lines' ? (
        refundableItems.length === 0 ? (
          <Alert tone="info">
            Every line has already been refunded in full. Use an amount if you are refunding
            shipping or issuing goodwill.
          </Alert>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
            {refundableItems.map((item) => {
              const remaining = item.quantity - item.quantityRefunded;
              return (
                <li key={item.id} className="flex items-center justify-between gap-4 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {item.productName}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {item.sku} · {remaining} of {item.quantity} refundable
                    </p>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-sm text-slate-600">
                    <span className="sr-only">Quantity to refund for {item.sku}</span>
                    <input
                      type="number"
                      min={0}
                      max={remaining}
                      step={1}
                      value={quantities[item.id] ?? 0}
                      onChange={(event) =>
                        setQuantities((current) => ({
                          ...current,
                          [item.id]: Math.max(
                            0,
                            Math.min(remaining, Number.parseInt(event.target.value, 10) || 0),
                          ),
                        }))
                      }
                      className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-right text-sm tabular-nums shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <Field
          label={`Amount to refund (${currency})`}
          name="amountCents"
          type="number"
          min="0.01"
          max={(refundableCents / 100).toFixed(2)}
          step="0.01"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={fieldErrors.amountCents}
          hint="Checked server-side against what remains captured."
          required
        />
      )}

      <SelectField
        label="Reason"
        name="reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={fieldErrors.reason}
      >
        {REASONS.map(([code, label]) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </SelectField>

      <TextareaField
        rows={4}
        label="Why is this being refunded?"
        name="notes"
        value={notes}
        maxLength={2000}
        onChange={(event) => setNotes(event.target.value)}
        error={
          fieldErrors.notes ??
          (notes.trim().length > 0 && notes.trim().length < NOTES_MIN
            ? `At least ${NOTES_MIN} characters.`
            : undefined)
        }
        hint="Recorded permanently against your name and cannot be edited afterwards."
        required
      />

      <Checkbox
        label="Return the refunded units to sellable stock"
        name="restock"
        checked={restock}
        onChange={(event) => setRestock(event.target.checked)}
        hint="Only tick this once the goods are physically back and fit to sell."
      />

      {overCeiling ? (
        <Alert tone="warning">That is more than remains refundable. The API will refuse it.</Alert>
      ) : null}

      {estimatedCents > 0 && !overCeiling ? (
        <p className="text-sm text-slate-600">
          About to refund <strong>{formatMoney(estimatedCents, currency)}</strong>. The exact amount
          is recomputed by the server from the order's own totals.
        </p>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button
        type="submit"
        loading={saving}
        loadingLabel="Issuing refund…"
        disabled={nothingChosen || overCeiling || notes.trim().length < NOTES_MIN}
      >
        Issue refund
      </Button>
    </form>
  );
}
