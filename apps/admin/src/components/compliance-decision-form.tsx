'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Recording a compliance decision.
 *
 * The notes field is required and has a real minimum length, enforced by the
 * API as well as here. That is not form politeness: the note is the record of
 * *why* a health product was signed off, it is kept permanently, it cannot be
 * edited afterwards, and it is what anyone asking that question later will
 * have to work from. A decision without reasoning is not a review.
 *
 * The form does not offer a way to publish. Approving satisfies one check on
 * the gate; someone with `PRODUCT_PUBLISH` still has to publish, and the gate
 * re-evaluates everything at that moment.
 */

const NOTES_MIN = 20;

export function ComplianceDecisionForm({
  productId,
  canDecide,
}: {
  productId: string;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState('APPROVED');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canDecide) {
    return (
      <Alert tone="info" title="You cannot record a decision">
        <p>
          This needs the <code className="font-mono">COMPLIANCE_APPROVE</code> permission, which is
          held by compliance reviewers.
        </p>
        <p className="mt-2">
          Administrators deliberately do not have it. Running the store and signing off a health
          product listing are separate authorities.
        </p>
      </Alert>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest(`/api/v1/compliance/products/${productId}/decision`, {
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
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  const tooShort = notes.trim().length > 0 && notes.trim().length < NOTES_MIN;

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <SelectField
        label="Decision"
        name="decision"
        value={decision}
        onChange={(event) => setDecision(event.target.value)}
        error={fieldErrors.decision}
      >
        <option value="APPROVED">Approve</option>
        <option value="CHANGES_REQUESTED">Request changes</option>
        <option value="REJECTED">Reject</option>
      </SelectField>

      {decision === 'REJECTED' ? (
        <Alert tone="warning">
          Rejecting takes the listing out of sale immediately if it is live. Leaving it up pending
          someone noticing would defeat the purpose of the rejection.
        </Alert>
      ) : null}

      <TextareaField
        rows={6}
        label="What did you review, and why this decision?"
        name="notes"
        value={notes}
        maxLength={5000}
        onChange={(event) => setNotes(event.target.value)}
        error={fieldErrors.notes ?? (tooShort ? `At least ${NOTES_MIN} characters.` : undefined)}
        hint="Kept permanently and cannot be edited afterwards. Name the documents you checked against."
        required
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" loading={saving} disabled={notes.trim().length < NOTES_MIN}>
        Record decision
      </Button>

      <p className="text-sm text-slate-500">
        Approving does not publish the listing. It satisfies one check; the publishing gate is
        re-evaluated in full when someone publishes.
      </p>
    </form>
  );
}
