'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Revising a claim's wording.
 *
 * Writes a new version; the approved one is untouched and keeps showing on the
 * live listing until the new wording is itself approved. That is why the form
 * says so plainly — a writer who assumes their edit is live will phrase the
 * change reason for the wrong audience.
 *
 * The change reason is required and permanent. It is the only record of why the
 * live wording differs from what was approved in March.
 */
export function ClaimReviseForm({
  claimId,
  currentText,
  currentContext,
  isApproved,
  canWrite,
}: {
  claimId: string;
  currentText: string;
  currentContext: string | null;
  isApproved: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(currentText);
  const [context, setContext] = useState(currentContext ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canWrite) {
    return (
      <p className="text-sm text-slate-500">
        Revising a claim needs the <code className="font-mono">CLAIM_WRITE</code> permission.
      </p>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest(`/api/v1/admin/compliance/claims/${claimId}/versions`, {
        method: 'POST',
        body: {
          text: text.trim(),
          ...(context.trim() ? { context: context.trim() } : {}),
          changeReason: changeReason.trim(),
        },
      });
      setChangeReason('');
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
      {isApproved ? (
        <Alert tone="info" title="The approved wording stays live">
          Saving a revision takes this claim back out of approval and sends it for review again.
          Until the new wording is approved, the listing keeps showing the version that was signed
          off.
        </Alert>
      ) : null}

      <TextareaField
        rows={3}
        label="Claim, exactly as it would appear on the listing"
        name="text"
        value={text}
        maxLength={500}
        onChange={(event) => setText(event.target.value)}
        error={fieldErrors.text}
        hint="One statement. A paragraph is several claims, and reviewing it as one hides which part the evidence supports."
        required
      />

      <Field
        label="Where it appears"
        name="context"
        value={context}
        maxLength={500}
        onChange={(event) => setContext(event.target.value)}
        error={fieldErrors.context}
        hint="For the reviewer's context — product page, label, advertisement."
      />

      <TextareaField
        rows={3}
        label="Why is the wording changing?"
        name="changeReason"
        value={changeReason}
        maxLength={2000}
        onChange={(event) => setChangeReason(event.target.value)}
        error={fieldErrors.changeReason}
        hint="Recorded permanently against this version. It is the only record of why the wording differs from what was approved."
        required
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button
        type="submit"
        loading={saving}
        disabled={text.trim().length < 3 || changeReason.trim().length < 10}
      >
        Save new version
      </Button>
    </form>
  );
}
