'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox } from '@health/ui';
import { clientRequest } from '@/lib/client';

interface Preferences {
  acceptsMarketingEmail: boolean;
  acceptsMarketingSms: boolean;
}

/**
 * Consent is opt-in and every change is written to an append-only ledger by the
 * API, so a withdrawal is recorded rather than overwriting the grant.
 */
export function MarketingPreferences({ initial }: { initial: Preferences }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const dirty =
    values.acceptsMarketingEmail !== initial.acceptsMarketingEmail ||
    values.acceptsMarketingSms !== initial.acceptsMarketingSms;

  async function save(): Promise<void> {
    setSaving(true);
    setStatus('idle');
    try {
      await clientRequest('/api/v1/me/preferences/marketing', { method: 'PUT', body: values });
      setStatus('saved');
      router.refresh();
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {status === 'saved' ? <Alert tone="success">Your preferences have been saved.</Alert> : null}
      {status === 'error' ? (
        <Alert tone="error">We could not save your preferences. Please try again.</Alert>
      ) : null}

      <Checkbox
        label="Product news and offers by email"
        checked={values.acceptsMarketingEmail}
        onChange={(event) =>
          setValues((current) => ({ ...current, acceptsMarketingEmail: event.target.checked }))
        }
      />
      <Checkbox
        label="Order reminders and offers by text message"
        hint="Standard message rates apply. You can reply STOP at any time."
        checked={values.acceptsMarketingSms}
        onChange={(event) =>
          setValues((current) => ({ ...current, acceptsMarketingSms: event.target.checked }))
        }
      />

      <Button loading={saving} loadingLabel="Saving…" disabled={!dirty} onClick={() => void save()}>
        Save preferences
      </Button>
    </div>
  );
}
