'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, SelectField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Adding a redirect by hand.
 *
 * Most redirects on this site are written by a rename rather than typed here.
 * This exists for the cases a rename cannot know about: a URL from a printed
 * leaflet, a campaign short link, a page that moved before this system existed.
 */
export function RedirectForm() {
  const router = useRouter();
  const [fromPath, setFromPath] = useState('');
  const [toPath, setToPath] = useState('');
  const [statusCode, setStatusCode] = useState('301');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await clientRequest('/api/v1/admin/growth/redirects', {
        method: 'POST',
        body: {
          fromPath: fromPath.trim(),
          toPath: toPath.trim(),
          statusCode: Number(statusCode),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      setFromPath('');
      setToPath('');
      setReason('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('We could not create that redirect. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="From"
          required
          value={fromPath}
          placeholder="/old-path"
          error={fieldErrors.fromPath}
          hint="A path on this site, without a query string."
          onChange={(event) => setFromPath(event.target.value)}
        />
        <Field
          label="To"
          required
          value={toPath}
          placeholder="/new-path"
          error={fieldErrors.toPath}
          hint="A path here, or a full https:// URL for a move to another domain."
          onChange={(event) => setToPath(event.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Kind"
          value={statusCode}
          onChange={(event) => setStatusCode(event.target.value)}
          hint="301 is cached hard by browsers and search engines. Use 302 for a move you intend to reverse."
        >
          <option value="301">301 — permanent</option>
          <option value="302">302 — temporary</option>
        </SelectField>
        <Field
          label="Why"
          value={reason}
          maxLength={200}
          error={fieldErrors.reason}
          hint="Optional, but the person reading this list in a year will thank you."
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      <Button type="submit" loading={busy} loadingLabel="Creating…">
        Add redirect
      </Button>
    </form>
  );
}
