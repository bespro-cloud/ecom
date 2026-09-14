'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Replying to a customer, or leaving an internal note.
 *
 * The internal switch is deliberately prominent and the composer changes colour
 * with it, because the failure mode here is writing a note about a customer and
 * sending it to them. An internal note also does not notify — a notification
 * about a note about somebody would be the same leak by another route.
 */
export function SupportStaffReply({ threadId, status }: { threadId: string; status: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [nextStatus, setNextStatus] = useState(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await clientRequest(`/api/v1/admin/lifecycle/support/${threadId}/replies`, {
        method: 'POST',
        body: { body, isInternal: internal },
      });
      setBody('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'We could not send that.');
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientRequest(`/api/v1/admin/lifecycle/support/${threadId}/status`, {
        method: 'POST',
        body: { status: nextStatus },
      });
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError ? caught.message : 'We could not change the status.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <form onSubmit={(event) => void send(event)} className="space-y-3" noValidate>
        <Checkbox
          label="Internal note — the customer never sees this"
          hint="Use for handover notes. An internal note does not notify the customer."
          checked={internal}
          onChange={(event) => setInternal(event.target.checked)}
        />

        <div className={internal ? 'rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200' : undefined}>
          <TextareaField
            label={internal ? 'Internal note' : 'Reply to the customer'}
            required
            rows={5}
            value={body}
            maxLength={4000}
            hint={
              internal
                ? 'Not shown to the customer, but it is still their data — keep it factual.'
                : 'Do not ask for or repeat details about the customer’s health, medication or symptoms.'
            }
            onChange={(event) => setBody(event.target.value)}
          />
        </div>

        <Button
          type="submit"
          loading={busy}
          loadingLabel="Sending…"
          disabled={body.trim().length === 0}
        >
          {internal ? 'Add internal note' : 'Send reply'}
        </Button>
      </form>

      <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
        <div className="w-56">
          <SelectField
            label="Status"
            value={nextStatus}
            onChange={(event) => setNextStatus(event.target.value)}
          >
            <option value="OPEN">Open</option>
            <option value="AWAITING_CUSTOMER">Waiting on the customer</option>
            <option value="RESOLVED">Resolved</option>
            <option value="CLOSED">Closed</option>
          </SelectField>
        </div>
        <Button
          variant="secondary"
          loading={busy}
          loadingLabel="Saving…"
          disabled={nextStatus === status}
          onClick={() => void changeStatus()}
        >
          Update status
        </Button>
      </div>
    </div>
  );
}
