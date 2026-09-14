'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@health/ui';
import { clientRequest } from '@/lib/client';

/**
 * Switches a code on or off.
 *
 * Switching off stops new redemptions. It does not undo redemptions already
 * taken — a discount somebody was given at checkout is part of an order that
 * has been priced and paid.
 */
export function CouponToggle({ couponId, isActive }: { couponId: string; isActive: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await clientRequest(`/api/v1/admin/lifecycle/coupons/${couponId}/active`, {
        method: 'POST',
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
