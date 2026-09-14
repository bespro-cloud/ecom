'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Replying to a conversation.
 *
 * There is no "internal note" control here and no field this form could set to
 * become one: the API refuses `isInternal` from a customer, and a database
 * CHECK refuses it regardless. A customer message marked internal would vanish
 * from the customer's own view of their conversation.
 */
export function SupportReplyForm({ threadId, closed }: { threadId: string; closed: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (closed) {
    return (
      <Alert tone="info" title="This conversation is closed">
        <p>Start a new one if you still need help — we will have the history.</p>
      </Alert>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await clientRequest(`/api/v1/account/support/${threadId}/replies`, {
        method: 'POST',
        body: { body },
      });
      setBody('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'We could not send your reply.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextareaField
        label="Reply"
        rows={5}
        required
        value={body}
        maxLength={4000}
        hint="Please do not include details about your health, medication or symptoms."
        onChange={(event) => setBody(event.target.value)}
      />
      <Button
        type="submit"
        loading={busy}
        loadingLabel="Sending…"
        disabled={body.trim().length === 0}
      >
        Send reply
      </Button>
    </form>
  );
}
