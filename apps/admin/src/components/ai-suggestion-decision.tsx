'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Accepting or rejecting a suggestion.
 *
 * The wording on the accept button is deliberate. This is not "apply" or "use
 * this" — it is the moment the text stops being a machine's and becomes the
 * accepting person's, recorded under their name in the audit log. A screen that
 * made it feel like a formality would be doing the opposite of what the whole
 * human-in-the-loop design is for.
 */
export function AiSuggestionDecision({
  suggestionId,
  blocked,
}: {
  suggestionId: string;
  blocked: boolean;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (blocked) {
    return (
      <Alert tone="error" title="The guardrails refused this text">
        <p>
          It cannot be accepted — not from this screen, and not by any other route: a database
          trigger refuses it regardless of what the application asks. Generate it again if it is
          still wanted.
        </p>
      </Alert>
    );
  }

  async function decide(decision: 'ACCEPTED' | 'REJECTED'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientRequest(`/api/v1/admin/ai/suggestions/${suggestionId}/decision`, {
        method: 'POST',
        body: { decision, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      });
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError ? caught.message : 'We could not record that decision.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <TextareaField
        label="Notes"
        rows={3}
        value={notes}
        maxLength={2000}
        hint="Optional on acceptance, useful on rejection — “why did we not use this?” is how the prompts get better."
        onChange={(event) => setNotes(event.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        <Button loading={busy} loadingLabel="Recording…" onClick={() => void decide('ACCEPTED')}>
          I have read this and stand behind it
        </Button>
        <Button variant="ghost" loading={busy} onClick={() => void decide('REJECTED')}>
          Reject
        </Button>
      </div>

      <p className="text-sm text-slate-500">
        Accepting records your name against these words and writes them to a draft. It publishes
        nothing and approves nothing.
      </p>
    </div>
  );
}
