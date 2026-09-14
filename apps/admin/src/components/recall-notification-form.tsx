'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Approving contact with affected customers.
 *
 * The most consequential control in the console, and the form is deliberately
 * awkward. The acknowledgement must be typed in full rather than ticked,
 * because this is not a decision anyone should reach by clicking through
 * screens — and a checkbox is exactly how that happens.
 *
 * It is also honest about what approving does. It does not send anything. The
 * platform has transactional email and recall notification is deliberately not
 * wired to it: approving unlocks the affected-customer list and records who
 * unlocked it and on what basis. Telling people remains a deliberate act
 * performed by a person who can answer the questions it will produce.
 */

const ACKNOWLEDGEMENT = 'I approve contacting affected customers';
const NOTES_MIN = 20;

export function RecallNotificationForm({
  recallId,
  customerCount,
  canApprove,
  mfaEnabled,
}: {
  recallId: string;
  customerCount: number;
  canApprove: boolean;
  mfaEnabled: boolean;
}) {
  const router = useRouter();
  const [acknowledgement, setAcknowledgement] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canApprove) {
    return (
      <Alert tone="info" title="You cannot approve customer contact">
        <p>
          This needs the <code className="font-mono">RECALL_NOTIFY</code> permission, held by
          compliance reviewers.
        </p>
        <p className="mt-2">
          It is deliberately separate from <code className="font-mono">RECALL_MANAGE</code>:
          withdrawing stock from sale is an operational act, and telling customers they consumed a
          recalled product has legal consequences. They are not the same authority.
        </p>
      </Alert>
    );
  }

  if (!mfaEnabled) {
    return (
      <Alert tone="warning" title="Enrol a second factor first">
        Approving customer contact during a recall requires multi-factor authentication. The API
        enforces this regardless of what this screen shows.
      </Alert>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest(`/api/v1/admin/traceability/recalls/${recallId}/approve-notification`, {
        method: 'POST',
        body: { acknowledgement: acknowledgement.trim(), notes: notes.trim() },
      });
      setAcknowledgement('');
      setNotes('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Reload and check whether the approval was recorded.');
      }
    } finally {
      setSaving(false);
    }
  }

  const typedCorrectly = acknowledgement.trim() === ACKNOWLEDGEMENT;

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Alert tone="warning" title="This decision has legal consequences">
        <p>
          Approving discloses the contact details of {customerCount} customer(s) who received the
          recalled goods, and records that you authorised contacting them.
        </p>
        <p className="mt-2">
          It cannot be undone: a recall whose notification has been approved is closed rather than
          cancelled.
        </p>
      </Alert>

      <Alert tone="info" title="Approving does not send anything">
        Approving contacts nobody. Recall notification is deliberately not wired to the
        transactional email the platform does have. It unlocks the list and records the decision;
        reaching out to customers remains a manual act performed by a person who can answer the
        questions it will produce.
      </Alert>

      <TextareaField
        rows={4}
        label="On what basis are you approving this?"
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
        hint="Include any legal or regulatory advice relied on. Recorded permanently against your name."
        required
      />

      <Field
        label={`Type "${ACKNOWLEDGEMENT}" to confirm`}
        name="acknowledgement"
        value={acknowledgement}
        onChange={(event) => setAcknowledgement(event.target.value)}
        error={fieldErrors.acknowledgement}
        autoComplete="off"
        required
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button
        type="submit"
        variant="danger"
        loading={saving}
        disabled={!typedCorrectly || notes.trim().length < NOTES_MIN}
      >
        Approve contacting customers
      </Button>
    </form>
  );
}
