'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Deciding a claim.
 *
 * The form names the version it is deciding on. If someone revised the wording
 * while this screen was open, the API refuses the decision rather than letting
 * an approval land on text the reviewer never read — the same class of problem
 * the checkout pricing fingerprint solves, with worse consequences.
 *
 * Notes are required at a real length and cannot be edited afterwards. They are
 * the record of *why* a health claim was signed off, and they are what anyone
 * asking that question later will have to work from.
 *
 * There is deliberately no "approve anyway" affordance for a claim without
 * substantiation, and none for a disease claim. Those are refused by the API on
 * category and evidence; a button that appeared to offer them would be a lie
 * about what the system permits.
 */

const NOTES_MIN = 20;

export function ClaimDecisionForm({
  claimId,
  versionId,
  versionNumber,
  claimType,
  substantiation,
  canDecide,
  mfaEnabled,
}: {
  claimId: string;
  versionId: string | null;
  versionNumber: number | null;
  claimType: string;
  substantiation: { sufficient: boolean; detail: string; contradictory: number };
  canDecide: boolean;
  mfaEnabled: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState('APPROVED');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canDecide) {
    return (
      <Alert tone="info" title="You cannot decide this claim">
        <p>
          This needs the <code className="font-mono">CLAIM_APPROVE</code> permission, held by
          compliance reviewers.
        </p>
        <p className="mt-2">
          Product managers and administrators deliberately do not have it. Writing a health claim
          and signing it off are separate authorities.
        </p>
      </Alert>
    );
  }

  if (!mfaEnabled) {
    return (
      <Alert tone="warning" title="Enrol a second factor first">
        Deciding a claim controls what customers are told about a health product, so it requires
        multi-factor authentication. The API enforces this regardless of what this screen shows.
      </Alert>
    );
  }

  if (!versionId) {
    return <Alert tone="warning">This claim has no wording to decide on.</Alert>;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest(`/api/v1/admin/compliance/claims/${claimId}/decision`, {
        method: 'POST',
        body: { decision, versionId, notes: notes.trim() },
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

  const isDisease = claimType === 'DISEASE';
  const blocked = decision === 'APPROVED' && (isDisease || !substantiation.sufficient);

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <p className="text-sm text-slate-600">
        Deciding on <strong>version {versionNumber}</strong>. If someone edits the wording before
        you submit, this will be refused rather than applied to the new text.
      </p>

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

      {isDisease && decision === 'APPROVED' ? (
        <Alert tone="error" title="A disease claim cannot be approved">
          No amount of evidence makes a disease claim lawful on a supplement listing. Rejecting it
          is the only available outcome.
        </Alert>
      ) : null}

      {!isDisease && decision === 'APPROVED' && !substantiation.sufficient ? (
        <Alert tone="warning" title="Not substantiated">
          {substantiation.detail}
        </Alert>
      ) : null}

      {substantiation.contradictory > 0 ? (
        <Alert tone="warning">
          {substantiation.contradictory} attached source(s) are marked as contradicting this claim.
          They are part of the substantiation file and are worth reading before you decide.
        </Alert>
      ) : null}

      <TextareaField
        rows={6}
        label="What did you review, and why this decision?"
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
        hint="Kept permanently and cannot be edited afterwards. Name the sources you relied on."
        required
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" loading={saving} disabled={blocked || notes.trim().length < NOTES_MIN}>
        Record decision
      </Button>

      <p className="text-sm text-slate-500">
        Approving does not publish anything. It satisfies one check; the publishing gate is
        re-evaluated in full when someone publishes the listing.
      </p>
    </form>
  );
}
