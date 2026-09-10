'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@health/ui';
import { clientRequest } from '@/lib/client';

export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await clientRequest('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Even if the call fails the local session is unusable; fall through to
      // the refresh so the user is not stranded on a signed-in-looking page.
    } finally {
      setBusy(false);
      startTransition(() => {
        router.replace('/');
        router.refresh();
      });
    }
  }

  return (
    <Button variant="ghost" size="sm" loading={busy || pending} onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}
