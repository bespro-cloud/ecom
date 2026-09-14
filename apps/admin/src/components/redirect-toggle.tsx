'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@health/ui';
import { clientRequest } from '@/lib/client';

/**
 * Switches a redirect off, rather than deleting it.
 *
 * Deleting makes the old URL start returning 404 again, which is usually not
 * what somebody wants when they say "remove this redirect" — and it throws away
 * the hit count that would have told them whether anyone was still using it.
 */
export function RedirectToggle({
  redirectId,
  isActive,
}: {
  redirectId: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await clientRequest(`/api/v1/admin/growth/redirects/${redirectId}`, {
        method: 'PATCH',
        body: { isActive: !isActive },
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" loading={busy} onClick={() => void toggle()}>
      {isActive ? 'Switch off' : 'Switch on'}
    </Button>
  );
}
