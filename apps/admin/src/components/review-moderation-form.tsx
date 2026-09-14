'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

const DECISIONS = [
  { value: 'PUBLISHED', label: 'Publish — put it on the product page' },
  { value: 'REJECTED', label: 'Reject — do not publish' },
  { value: 'ESCALATED', label: 'Escalate to compliance' },
  { value: 'WITHDRAWN', label: 'Withdraw — take it down' },
] as const;

const REASONS = [
  { value: 'HEALTH_CLAIM', label: 'Reads as a claim about treating or preventing a disease' },
  { value: 'ADVERSE_EVENT', label: 'Describes harm the customer experienced' },
  { value: 'PERSONAL_INFORMATION', label: 'Contains personal information' },
  { value: 'ABUSIVE', label: 'Abusive' },
  { value: 'SPAM', label: 'Spam' },
  { value: 'OFF_TOPIC', label: 'Off topic' },
  { value: 'OTHER', label: 'Something else' },
] as const;

/**
 * A moderation decision.
 *
 * Written reasoning is required on every outcome, publication included: "why is
 * this live?" is as worth answering as "why was this rejected?", and on a
 * health product it is the more important of the two. The API enforces it, so
 * this form cannot be bypassed to skip it.
 *
 * The adverse-event flag is independent of the outcome. A customer describing
 * harm is a safety signal whether or not their words go on the site, and
 * pairing the flag to "reject" would lose the ones we publish.
 */
export function ReviewModerationForm({
  reviewId,
  suggestAdverseEvent,
}: {
  reviewId: string;
  suggestAdverseEvent: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<string>('PUBLISHED');
  const [reason, setReason] = useState<string>('HEALTH_CLAIM');
  const [notes, setNotes] = useState('');
  const [flag, setFlag] = useState(suggestAdverseEvent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await clientRequest(`/api/v1/admin/lifecycle/reviews/${reviewId}/moderate`, {
        method: 'POST',
        body: {
          decision,
          notes,
          flagAdverseEvent: flag,
          ...(decision === 'REJECTED' ? { reason } : {}),
        },
      });
      router.refresh();
      router.push('/reviews');
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('We could not record that decision. Please try again.');
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <SelectField
        label="Decision"
        required
        value={decision}
        error={fieldErrors.decision}
        onChange={(event) => setDecision(event.target.value)}
      >
        {DECISIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>

      {decision === 'ESCALATED' ? (
        <Alert tone="warning" title="Escalation cannot be taken back">
          <p>
            The decision passes to the compliance team. You will not be able to publish or reject
            this review afterwards.
          </p>
        </Alert>
      ) : null}

      {decision === 'REJECTED' ? (
        <SelectField
          label="Why?"
          required
          value={reason}
          error={fieldErrors.reason}
          onChange={(event) => setReason(event.target.value)}
        >
          {REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      ) : null}

      <TextareaField
        label="Your reasoning"
        required
        rows={4}
        value={notes}
        maxLength={2000}
        error={fieldErrors.notes}
        hint="Recorded permanently against the review. Required whatever you decide."
        onChange={(event) => setNotes(event.target.value)}
      />

      <Checkbox
        label="This review describes harm the customer experienced"
        hint="Recorded as a safety signal regardless of whether the review is published."
        checked={flag}
        onChange={(event) => setFlag(event.target.checked)}
      />

      <Button type="submit" loading={busy} loadingLabel="Recording…">
        Record decision
      </Button>
    </form>
  );
}
