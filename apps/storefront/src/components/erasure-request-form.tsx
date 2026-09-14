'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

const PHRASE = 'DELETE MY ACCOUNT';

/**
 * Asking for an account to be deleted.
 *
 * The confirmation phrase is typed, not ticked, because this is irreversible
 * and a checkbox is a mis-click. The API requires the same literal string, so
 * the guard is real rather than a courtesy this form could be bypassed to skip.
 *
 * The request is reviewed by a person. Nothing here deletes anything, and the
 * screen says so instead of implying the account is already gone.
 */
export function ErasureRequestForm() {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await clientRequest('/api/v1/account/erasure', {
        method: 'POST',
        body: {
          acknowledgement: phrase.trim(),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      setSent(true);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError
          ? caught.message
          : 'We could not record your request. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Alert tone="success" title="We have your request">
        <p>
          A member of our team will review it, usually within a few days. We will write to you to
          say what we removed and what we had to keep.
        </p>
      </Alert>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <TextareaField
        label="Why are you asking? (optional)"
        hint="You do not have to give a reason."
        rows={3}
        value={reason}
        maxLength={1000}
        onChange={(event) => setReason(event.target.value)}
      />

      <Field
        label={`Type ${PHRASE} to confirm`}
        required
        value={phrase}
        autoComplete="off"
        onChange={(event) => setPhrase(event.target.value)}
      />

      <Button
        type="submit"
        variant="danger"
        loading={busy}
        loadingLabel="Sending…"
        disabled={phrase.trim() !== PHRASE}
      >
        Request deletion
      </Button>
    </form>
  );
}
