'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';
import type { AdminStockRow } from '@/lib/commerce';

/**
 * Adjusting stock.
 *
 * Quantities are never typed in directly as a new total — the form takes a
 * signed delta with a required reason, and the API writes it to an append-only
 * ledger alongside the resulting on-hand figure. That is what makes "we are
 * eleven units short" an answerable question months later.
 *
 * The API refuses an adjustment that would take on-hand below what is reserved
 * for open orders. That refusal is the real control; this form mirrors it so the
 * operator finds out before submitting rather than after.
 */

const REASONS = [
  ['RECEIPT', 'Stock received'],
  ['RETURN', 'Customer return'],
  ['DAMAGE', 'Damaged or destroyed'],
  ['LOSS', 'Lost or unaccounted for'],
  ['CORRECTION', 'Count correction'],
  ['TRANSFER_IN', 'Transferred in'],
  ['TRANSFER_OUT', 'Transferred out'],
  ['EXPIRY', 'Expired'],
] as const;

export function StockAdjustForm({ row, canAdjust }: { row: AdminStockRow; canAdjust: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<string>('RECEIPT');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canAdjust) return null;

  const parsed = Number.parseInt(delta, 10);
  const valid = Number.isInteger(parsed) && parsed !== 0;
  const resulting = valid ? row.onHandQuantity + parsed : row.onHandQuantity;
  const belowReserved = valid && resulting < row.reservedQuantity;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest('/api/v1/admin/commerce/inventory/adjustments', {
        method: 'POST',
        body: {
          variantId: row.variantId,
          warehouseId: row.warehouse.id,
          quantityDelta: parsed,
          reason,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      setDelta('');
      setReference('');
      setNotes('');
      setOpen(false);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Reload and check the current level before retrying.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Adjust
      </Button>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="w-72 space-y-3 text-left">
      <Field
        label="Change in units"
        name="quantityDelta"
        type="number"
        step={1}
        value={delta}
        onChange={(event) => setDelta(event.target.value)}
        error={fieldErrors.quantityDelta}
        hint="Negative removes stock. Zero changes nothing."
        required
      />

      {valid ? (
        <p className="text-sm text-slate-600">
          On hand would become <strong className="tabular-nums">{resulting}</strong>, with{' '}
          <span className="tabular-nums">{row.reservedQuantity}</span> reserved for open orders.
        </p>
      ) : null}

      {belowReserved ? (
        <Alert tone="warning">
          That would leave less stock than is already promised to open orders. The API will refuse
          it — cancel or refund those orders first.
        </Alert>
      ) : null}

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

      <Field
        label="Reference"
        name="reference"
        value={reference}
        maxLength={120}
        onChange={(event) => setReference(event.target.value)}
        error={fieldErrors.reference}
        hint="Purchase order, RMA or count sheet, if there is one."
      />

      <TextareaField
        rows={2}
        label="Notes"
        name="notes"
        value={notes}
        maxLength={1000}
        onChange={(event) => setNotes(event.target.value)}
        error={fieldErrors.notes}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={saving} disabled={!valid || belowReserved}>
          Record
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
