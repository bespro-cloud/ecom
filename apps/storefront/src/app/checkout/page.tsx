import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { fetchCart } from '@/lib/commerce';
import { CheckoutFlow } from '@/components/checkout-flow';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const cart = await fetchCart();

  if (cart.lines.length === 0) {
    redirect('/cart');
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Checkout</h1>
      <p className="mt-2 text-sm text-slate-600">
        <Link href="/cart" className="underline">
          Back to your basket
        </Link>
      </p>

      <div className="mt-8">
        <CheckoutFlow cart={cart} />
      </div>
    </div>
  );
}
