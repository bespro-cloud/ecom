'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Deciding a deletion request.
 *
 * Separate from CUSTOMER_WRITE on purpose: correcting a misspelled name and
 * erasing somebody's data are not the same authority, and only one of them is
 * irreversible. It also requires a second factor — the API enforces that
 * regardless of what this screen shows.
 *
 * Written reasoning is required because this is the response to a legal
 * request. "What did you remove and what did you keep?" has to be answerable
 * years later by someone who was not in the room.
 */
export function ErasureDecisionForm({
  requestId,
  canDecide,
  mfaEnabled,
}: {
  requestId: string;
  canDecide: boolean;
  mfaEnabled: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState('COMPLETED');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canDecide) {
    return (
      <Alert tone="info" title="You cannot decide deletion requests">
        <p>
          This needs the <code className="font-mono">CUSTOMER_ERASE</code> permission. It is
          deliberately separate from <code className="font-mono">CUSTOMER_WRITE</code>: editing an
          account and erasing one are not the same authority, and the second cannot be undone.
        </p>
      </Alert>
    );
  }

  if (!mfaEnabled) {
    return (
      <Alert tone="warning" title="Enrol a second factor first">
        Deciding a deletion request requires multi-factor authentication. The API enforces this
        regardless of what this screen shows.
      </Alert>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await clientRequest(`/api/v1/admin/lifecycle/erasure-requests/${requestId}/decision`, {
        method: 'POST',
        body: { decision, notes: notes.trim() },
      });
      setNotes('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Reload and check whether the decision was recorded.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Alert tone="warning" title="Completing this cannot be undone">
        <p>
          Contact details, addresses, saved payment tokens, support conversations and the sign-in
          are removed. Orders, payments, consent history and the record of which lots the customer
          received are kept — that last one is what lets a recall reach them, and the obligation
          does not lapse because somebody closed their account.
        </p>
        <p className="mt-2">
          Reviews are anonymised rather than deleted: removing them would silently change a
          published rating other customers rely on. The name comes off; the words stay.
        </p>
      </Alert>

      <SelectField
        label="Decision"
        required
        value={decision}
        error={fieldErrors.decision}
        onChange={(event) => setDecision(event.target.value)}
      >
        <option value="COMPLETED">Carry out the deletion</option>
        <option value="REFUSED">Refuse</option>
      </SelectField>

      <TextareaField
        label="What you removed, what you kept, and why"
        required
        rows={5}
        value={notes}
        maxLength={4000}
        error={fieldErrors.notes}
        hint="This is the response to a legal request. Write it for someone reading it in two years."
        onChange={(event) => setNotes(event.target.value)}
      />

      <Button
        type="submit"
        variant={decision === 'COMPLETED' ? 'danger' : 'primary'}
        loading={busy}
        loadingLabel="Recording…"
        disabled={notes.trim().length < 20}
      >
        Record decision
      </Button>
    </form>
  );
}
