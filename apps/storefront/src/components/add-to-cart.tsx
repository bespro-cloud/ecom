'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';

/**
 * Adding a product to the basket.
 *
 * The quantity is the only thing sent. There is no price, no line total and no
 * currency in this request — the server prices from the catalogue, and a field
 * here that looked like a price would invite someone to try setting it.
 *
 * `availableQuantity` is shown but not enforced: by the time someone clicks it
 * may be stale, and the real decision is made under a row lock at checkout. A
 * button disabled on a stale read would be a worse lie than an honest refusal
 * later.
 */
export function AddToCart({
  variantId,
  availableQuantity,
}: {
  variantId: string;
  availableQuantity: number | null;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const soldOut = availableQuantity !== null && availableQuantity <= 0;

  async function add(): Promise<void> {
    setBusy(true);
    setError(null);
    setAdded(false);

    try {
      await clientRequest('/api/v1/cart/items', { method: 'POST', body: { variantId, quantity } });
      setAdded(true);
      // Refreshes the header count and anything else reading the basket.
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError
          ? caught.message
          : 'We could not add that to your basket. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (soldOut) {
    return (
      <Alert tone="info" title="Out of stock">
        This product is not available at the moment. It will reappear here when it is back.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3">
        <div>
          <label htmlFor="quantity" className="block text-sm font-medium text-slate-700">
            Quantity
          </label>
          <input
            id="quantity"
            type="number"
            min={1}
            max={availableQuantity ?? 99}
            value={quantity}
            onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
            className="mt-1 w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
        </div>

        <Button size="lg" loading={busy} onClick={() => void add()}>
          Add to basket
        </Button>
      </div>

      {availableQuantity !== null && availableQuantity <= 5 ? (
        <p className="text-sm text-amber-700">Only {availableQuantity} left.</p>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      {added ? (
        <Alert tone="success">
          Added to your basket.{' '}
          <a href="/cart" className="font-medium underline">
            View basket
          </a>
        </Alert>
      ) : null}
    </div>
  );
}
