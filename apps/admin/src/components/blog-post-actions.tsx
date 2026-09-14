'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Everything a person can do to a post, and the refusals that go with it.
 *
 * The compliance decision is separated from publishing on purpose: a writer who
 * could sign off their own product claims is not a gate, it is a formality. The
 * API enforces that with `COMPLIANCE_APPROVE` and a second factor; this screen
 * explains it rather than hiding the button and leaving people guessing.
 */
export function BlogPostActions({
  postId,
  status,
  needsCompliance,
  publishable,
  approvalMatchesCurrentText,
  hasApproval,
  canWrite,
  canPublish,
  canApprove,
  mfaEnabled,
}: {
  postId: string;
  status: string;
  needsCompliance: boolean;
  publishable: boolean;
  approvalMatchesCurrentText: boolean;
  hasApproval: boolean;
  canWrite: boolean;
  canPublish: boolean;
  canApprove: boolean;
  mfaEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState('APPROVED');
  const [notes, setNotes] = useState('');

  async function act(path: string, body?: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientRequest(`/api/v1/admin/growth/blog/posts/${postId}${path}`, {
        method: 'POST',
        body: body ?? {},
      });
      setNotes('');
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError ? caught.message : 'We could not complete that action.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <Alert tone="error">{error}</Alert> : null}

      {needsCompliance && hasApproval && !approvalMatchesCurrentText ? (
        <Alert tone="warning" title="This has changed since it was approved">
          <p>
            The approval on file was of different text. Publishing is refused until a compliance
            reviewer reads the current version — the approval records what somebody read, and the
            words have moved since.
          </p>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canWrite && needsCompliance && status !== 'PUBLISHED' ? (
          <Button
            variant="secondary"
            loading={busy}
            loadingLabel="Sending…"
            onClick={() => void act('/submit')}
          >
            Send to compliance
          </Button>
        ) : null}

        {canPublish ? (
          <Button
            loading={busy}
            loadingLabel="Publishing…"
            disabled={!publishable}
            onClick={() => void act('/publish')}
          >
            {status === 'PUBLISHED' ? 'Publish current draft' : 'Publish'}
          </Button>
        ) : null}

        {canPublish && status === 'PUBLISHED' ? (
          <Button variant="ghost" loading={busy} onClick={() => void act('/unpublish')}>
            Take it down
          </Button>
        ) : null}
      </div>

      {canPublish && !publishable && needsCompliance ? (
        <p className="text-sm text-slate-600">
          Publishing is unavailable until compliance has approved the text as it stands.
        </p>
      ) : null}

      {needsCompliance ? (
        <div className="border-t border-slate-200 pt-6">
          <h3 className="text-base font-semibold text-slate-900">Compliance decision</h3>

          {!canApprove ? (
            <Alert tone="info" title="You cannot decide this">
              <p>
                It needs the <code className="font-mono">COMPLIANCE_APPROVE</code> permission, held
                by compliance reviewers. It is deliberately not held by content staff, marketing or
                administrators: a writer who could approve their own product claims would not be a
                gate.
              </p>
            </Alert>
          ) : !mfaEnabled ? (
            <Alert tone="warning" title="Enrol a second factor first">
              Approving copy that makes product claims requires multi-factor authentication. The API
              enforces this regardless of what this screen shows.
            </Alert>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act('/review', { decision, notes: notes.trim() });
              }}
              className="mt-4 space-y-4"
              noValidate
            >
              <SelectField
                label="Decision"
                required
                value={decision}
                onChange={(event) => setDecision(event.target.value)}
              >
                <option value="APPROVED">Approve — this may be published</option>
                <option value="REJECTED">Reject — send it back to the writer</option>
              </SelectField>

              <TextareaField
                label="What you read, and why you decided this"
                required
                rows={4}
                value={notes}
                maxLength={4000}
                hint="Required on either outcome, and recorded permanently against the text you read. “Why is this live?” is asked later."
                onChange={(event) => setNotes(event.target.value)}
              />

              <Button
                type="submit"
                loading={busy}
                loadingLabel="Recording…"
                disabled={notes.trim().length < 10}
              >
                Record decision
              </Button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
