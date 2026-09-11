import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchCart } from '@/lib/commerce';
import { formatMoney } from '@/lib/format';
import { CartLines } from '@/components/cart-lines';

export const metadata: Metadata = {
  title: 'Your basket',
  // A basket is per-visitor and has nothing to index.
  robots: { index: false, follow: true },
};

// Never cached, and never statically rendered: this is one visitor's basket.
export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const cart = await fetchCart();

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Your basket</h1>

      {cart.lines.length === 0 && cart.unavailable.length === 0 ? (
        <div className="mt-8 rounded-xl bg-white p-10 text-center ring-1 ring-slate-200">
          <p className="text-sm text-slate-600">There is nothing in your basket yet.</p>
          <Link
            href="/products"
            className="mt-4 inline-flex rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Browse products
          </Link>
        </div>
      ) : (
        <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_20rem]">
          <CartLines cart={cart} />

          <aside className="h-fit rounded-xl bg-white p-5 ring-1 ring-slate-200">
            <h2 className="text-base font-semibold text-slate-900">Summary</h2>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Subtotal</dt>
                <dd className="font-medium text-slate-900">
                  {formatMoney(cart.subtotalCents, cart.currency)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Delivery</dt>
                {/* Not "Free" and not a guess: it depends on the address, and
                    quoting a number here that changes at checkout is how a
                    customer ends up feeling misled. */}
                <dd className="text-slate-500">Calculated at checkout</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Tax</dt>
                <dd className="text-slate-500">Calculated at checkout</dd>
              </div>
            </dl>

            <Link
              href="/checkout"
              aria-disabled={cart.lines.length === 0}
              className={`mt-5 block rounded-lg px-4 py-2.5 text-center text-sm font-medium text-white ${
                cart.lines.length === 0
                  ? 'pointer-events-none bg-slate-300'
                  : 'bg-brand-600 hover:bg-brand-700'
              }`}
            >
              Checkout
            </Link>

            <p className="mt-3 text-xs text-slate-500">
              Prices are confirmed at checkout against the catalogue, so what you are shown there is
              what you pay.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
