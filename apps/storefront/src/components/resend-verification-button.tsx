'use client';

import { useState } from 'react';
import { Button } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';

export function ResendVerificationButton() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'throttled'>('idle');

  async function resend(): Promise<void> {
    setState('sending');
    try {
      await clientRequest('/api/v1/auth/email/resend', { method: 'POST' });
      setState('sent');
    } catch (error) {
      setState(error instanceof ClientApiError && error.status === 429 ? 'throttled' : 'idle');
    }
  }

  if (state === 'sent') {
    return (
      <p className="text-sm font-medium text-emerald-800" role="status">
        Sent. Check your inbox, including the spam folder.
      </p>
    );
  }

  if (state === 'throttled') {
    return (
      <p className="text-sm font-medium text-amber-800" role="status">
        We have already sent one recently. Please wait a few minutes before trying again.
      </p>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={state === 'sending'}
      loadingLabel="Sending…"
      onClick={() => void resend()}
    >
      Send another confirmation email
    </Button>
  );
}
