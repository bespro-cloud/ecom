'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@health/ui';
import { clientRequest } from '@/lib/client';

export function SignOutEverywhereButton() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function signOutAll(): Promise<void> {
    setBusy(true);
    try {
      await clientRequest('/api/v1/auth/logout-all', { method: 'POST' });
    } finally {
      // This ends the current session too, so send the user to sign-in either
      // way rather than leaving them on a page they can no longer use.
      router.replace('/login');
      router.refresh();
    }
  }

  if (!confirming) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
        Sign out everywhere
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-slate-600">This will sign you out on this device too.</p>
      <Button
        variant="danger"
        size="sm"
        loading={busy}
        loadingLabel="Signing out…"
        onClick={() => void signOutAll()}
      >
        Confirm
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
  );
}
