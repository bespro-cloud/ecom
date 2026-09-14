'use client';

import { useState } from 'react';
import { Alert, Button } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Downloads everything the business holds about the customer.
 *
 * The file is built in the browser from the API's response and never written to
 * storage the page can leave behind. The export contains personal data, so it
 * goes straight from the response to a download and nowhere else — not
 * `localStorage`, not a query string, not a log.
 */
export function DataExportButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(): Promise<void> {
    setBusy(true);
    setError(null);
    let url: string | null = null;
    try {
      const data = await clientRequest<unknown>('/api/v1/account/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `your-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError
          ? caught.message
          : 'We could not prepare your export. Please try again.',
      );
    } finally {
      // Released immediately: the object URL is a handle to personal data held
      // in this tab's memory, and there is no reason to keep it alive.
      if (url) URL.revokeObjectURL(url);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button loading={busy} loadingLabel="Preparing…" onClick={() => void download()}>
        Download my data
      </Button>
    </div>
  );
}
