'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert } from '@health/ui';
import type { Cart } from '@/lib/commerce';
import { clientRequest, ClientApiError } from '@/lib/client';
import { formatMoney } from '@/lib/format';

/**
 * The basket lines.
 *
 * Two things worth noting. A line whose price has moved since it went in says
 * so, rather than quietly showing the new number — the customer chose at a
 * price and deserves to know it changed. And an item that has become
 * unpurchasable is listed with the reason instead of disappearing; a basket
 * that silently loses things is worse than one that explains itself.
 */
export function CartLines({ cart }: { cart: Cart }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function setQuantity(itemId: string, quantity: number): Promise<void> {
    setError(null);
    try {
      await clientRequest(`/api/v1/cart/items/${itemId}`, { method: 'PATCH', body: { quantity } });
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(
        caught instanceof ClientApiError ? caught.message : 'We could not update your basket.',
      );
    }
  }

  return (
    <div className="space-y-4">
      {cart.unavailable.length > 0 ? (
        <Alert tone="warning" title="Some items are no longer available">
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {cart.unavailable.map((entry) => (
              <li key={entry.variantId}>
                {entry.name} — {entry.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <ul className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
        {cart.lines.map((line) => (
          <li key={line.id} className="flex gap-4 p-4">
            <div className="min-w-0 flex-1">
              <Link
                href={`/products/${line.slug}`}
                className="font-medium text-slate-900 hover:underline"
              >
                {line.productName}
              </Link>
              <p className="text-sm text-slate-600">{line.variantName}</p>
              <p className="font-mono text-xs text-slate-500">{line.sku}</p>

              {line.priceChanged ? (
                <p className="mt-1 text-sm text-amber-700">
                  The price changed from {formatMoney(line.quotedUnitPriceCents, line.currency)} to{' '}
                  {formatMoney(line.unitPriceCents, line.currency)} since you added this.
                </p>
              ) : null}

              {line.availableQuantity !== null && line.availableQuantity < line.quantity ? (
                <p className="mt-1 text-sm text-red-700">
                  Only {line.availableQuantity} left; reduce the quantity to continue.
                </p>
              ) : null}

              <div className="mt-3 flex items-center gap-3">
                <label htmlFor={`qty-${line.id}`} className="text-sm text-slate-600">
                  Quantity
                </label>
                <input
                  id={`qty-${line.id}`}
                  type="number"
                  min={0}
                  max={999}
                  defaultValue={line.quantity}
                  disabled={pending}
                  onBlur={(event) => {
                    const next = Math.max(0, Number(event.target.value) || 0);
                    if (next !== line.quantity) void setQuantity(line.id, next);
                  }}
                  className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void setQuantity(line.id, 0)}
                  className="text-sm font-medium text-slate-600 underline hover:text-red-700"
                >
                  Remove
                </button>
              </div>
            </div>

            <div className="shrink-0 text-right">
              <p className="font-medium text-slate-900">
                {formatMoney(line.lineSubtotalCents, line.currency)}
              </p>
              <p className="text-xs text-slate-500">
                {formatMoney(line.unitPriceCents, line.currency)} each
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
