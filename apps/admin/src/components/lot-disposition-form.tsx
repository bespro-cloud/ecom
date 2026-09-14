'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Holding or releasing a lot.
 *
 * A written reason is required in both directions, and cannot be edited
 * afterwards. Releasing is the more dangerous of the two to have no record of:
 * "why was this held?" usually has a paper trail elsewhere, while "on what
 * basis did we decide it was fine?" often does not.
 *
 * Only transitions the system actually permits are offered. Recalled and
 * expired stock cannot return to sale at all — correcting a mistaken recall
 * means receiving the goods again as a new lot, with the receipt recorded.
 */

const OPTIONS: Record<string, Array<[string, string]>> = {
  AVAILABLE: [
    ['QUARANTINED', 'Quarantine — hold pending a decision'],
    ['DISPOSED', 'Dispose — written off, destroyed or returned'],
  ],
  QUARANTINED: [
    ['AVAILABLE', 'Release back to sale'],
    ['DISPOSED', 'Dispose — written off, destroyed or returned'],
  ],
  RECALLED: [['DISPOSED', 'Dispose — written off, destroyed or returned']],
  EXPIRED: [['DISPOSED', 'Dispose — written off, destroyed or returned']],
  DISPOSED: [],
};

export function LotDispositionForm({
  batchId,
  currentStatus,
  quantityReserved,
  canManage,
}: {
  batchId: string;
  currentStatus: string;
  quantityReserved: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const options = OPTIONS[currentStatus] ?? [];
  const [status, setStatus] = useState(options[0]?.[0] ?? '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canManage) {
    return (
      <p className="text-sm text-slate-500">
        Changing a lot&apos;s disposition needs the{' '}
        <code className="font-mono">BATCH_QUARANTINE</code> permission.
      </p>
    );
  }

  if (options.length === 0) {
    return (
      <Alert tone="info">
        A {currentStatus.toLowerCase()} lot has no further disposition available. Correcting a
        mistake means receiving the goods again as a new lot, so the receipt is on record.
      </Alert>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest(`/api/v1/admin/traceability/batches/${batchId}/disposition`, {
        method: 'POST',
        body: { status, reason: reason.trim() },
      });
      setReason('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <SelectField
        label="New disposition"
        name="status"
        value={status}
        onChange={(event) => setStatus(event.target.value)}
        error={fieldErrors.status}
      >
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>

      {quantityReserved > 0 && status !== 'AVAILABLE' ? (
        <Alert tone="warning">
          {quantityReserved} unit(s) from this lot are already promised to open orders. Holding the
          lot does not cancel them — that is a decision for someone with the orders in front of
          them.
        </Alert>
      ) : null}

      <TextareaField
        rows={3}
        label="On what basis?"
        name="reason"
        value={reason}
        maxLength={2000}
        onChange={(event) => setReason(event.target.value)}
        error={
          fieldErrors.reason ??
          (reason.trim().length > 0 && reason.trim().length < 10
            ? 'At least 10 characters.'
            : undefined)
        }
        hint="Recorded permanently in the lot's history and cannot be edited."
        required
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" loading={saving} disabled={reason.trim().length < 10}>
        Record
      </Button>
    </form>
  );
}
