'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { Alert, Button, Field } from '@health/ui';
import type { Cart, Checkout } from '@/lib/commerce';
import { clientRequest, ClientApiError } from '@/lib/client';
import { formatMoney } from '@/lib/format';

/**
 * The checkout flow.
 *
 * Three decisions worth stating, because each of them is about not lying to the
 * customer.
 *
 * **The totals shown always come from the server.** This component never
 * computes a price, a tax figure or a total. It renders what the checkout
 * endpoint returned, so the number on screen is the number the server will
 * charge — and when the basket changes underneath, the server says so and the
 * page shows the new figure rather than the stale one.
 *
 * **The idempotency key is generated once and reused.** A double-clicked
 * button, a retried request or a browser that fires twice must produce one
 * order. The key is created on mount and kept in a ref so a re-render cannot
 * change it.
 *
 * **Nothing here handles card details.** With a real provider the payment step
 * hands off to the provider's own element against a client secret; the card
 * number never enters this application's DOM, which is what keeps the server
 * out of PCI scope.
 */

function newIdempotencyKey(): string {
  // 32 hex characters: long enough to be unique per attempt, and matching the
  // key format the API validates.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `co-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

type Step = 'details' | 'payment' | 'placing';

export function CheckoutFlow({ cart }: { cart: Cart }) {
  const router = useRouter();
  const idempotencyKey = useRef<string>(newIdempotencyKey());

  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [step, setStep] = useState<Step>('details');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [email, setEmail] = useState('');
  const [address, setAddress] = useState({
    firstName: '',
    lastName: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: 'US',
  });
  const [shippingCode, setShippingCode] = useState<string | null>(null);

  /** Starts (or re-attaches to) the checkout for this basket. */
  const start = useCallback(async (): Promise<Checkout | null> => {
    try {
      return await clientRequest<Checkout>('/api/v1/checkout', {
        method: 'POST',
        body: { idempotencyKey: idempotencyKey.current, email },
      });
    } catch (caught) {
      setError(
        caught instanceof ClientApiError ? caught.message : 'We could not start your checkout.',
      );
      return null;
    }
  }, [email]);

  async function saveDetails(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const started = checkout ?? (await start());
      if (!started) return;

      const updated = await clientRequest<Checkout>(`/api/v1/checkout/${started.id}`, {
        method: 'PATCH',
        body: {
          email,
          shippingAddress: {
            ...address,
            line2: address.line2 || undefined,
          },
          ...(shippingCode ? { shippingMethodCode: shippingCode } : {}),
        },
      });

      setCheckout(updated);

      // A delivery method has to be chosen before the total is real, so the
      // customer stays on this step until one is selected.
      if (updated.shippingMethodCode) setStep('payment');
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function chooseShipping(code: string): Promise<void> {
    if (!checkout) return;
    setShippingCode(code);
    setBusy(true);
    try {
      const updated = await clientRequest<Checkout>(`/api/v1/checkout/${checkout.id}`, {
        method: 'PATCH',
        body: { shippingMethodCode: code },
      });
      setCheckout(updated);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pays and places the order.
   *
   * The fingerprint is sent back exactly as the server produced it. If the
   * basket moved in the meantime the server refuses, and the customer is shown
   * the new total rather than charged the old one.
   */
  async function pay(): Promise<void> {
    if (!checkout?.pricingFingerprint) return;

    setBusy(true);
    setStep('placing');
    setError(null);

    try {
      await clientRequest(`/api/v1/checkout/${checkout.id}/prepare`, {
        method: 'POST',
        body: { pricingFingerprint: checkout.pricingFingerprint },
      });

      // With a real provider the customer completes payment here, against the
      // client secret, in the provider's own element. The development adapter
      // has no such step, so the flow proceeds straight to placing the order —
      // and the server still refuses unless the provider reports it settled.
      const placed = await clientRequest<{ orderId: string; reference: string }>(
        `/api/v1/checkout/${checkout.id}/complete`,
        { method: 'POST' },
      );

      router.push(`/orders/${placed.orderId}?placed=1`);
    } catch (caught) {
      setStep('payment');

      if (caught instanceof ClientApiError) {
        setError(caught.message);
        // A repriced basket: refresh so the customer sees the new figures.
        if (caught.code === 'CONFLICT') {
          const refreshed = await clientRequest<Checkout>(`/api/v1/checkout/${checkout.id}`);
          setCheckout(refreshed);
        }
      } else {
        setError('We could not complete your order. No payment has been taken.');
      }
    } finally {
      setBusy(false);
    }
  }

  const totals = checkout ?? {
    subtotalCents: cart.subtotalCents,
    shippingCents: 0,
    taxCents: 0,
    totalCents: cart.subtotalCents,
    taxRateApplied: null as number | null,
    currency: cart.currency,
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        {step === 'details' || !checkout ? (
          <form onSubmit={saveDetails} noValidate className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">Delivery details</h2>

            <Field
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={fieldErrors.email}
              hint="For your order confirmation and delivery updates."
              required
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="First name"
                name="firstName"
                value={address.firstName}
                onChange={(e) => setAddress((a) => ({ ...a, firstName: e.target.value }))}
                error={fieldErrors['shippingAddress.firstName']}
                required
              />
              <Field
                label="Last name"
                name="lastName"
                value={address.lastName}
                onChange={(e) => setAddress((a) => ({ ...a, lastName: e.target.value }))}
                error={fieldErrors['shippingAddress.lastName']}
                required
              />
            </div>

            <Field
              label="Address"
              name="line1"
              value={address.line1}
              onChange={(e) => setAddress((a) => ({ ...a, line1: e.target.value }))}
              error={fieldErrors['shippingAddress.line1']}
              required
            />
            <Field
              label="Apartment, suite (optional)"
              name="line2"
              value={address.line2}
              onChange={(e) => setAddress((a) => ({ ...a, line2: e.target.value }))}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="City"
                name="city"
                value={address.city}
                onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                error={fieldErrors['shippingAddress.city']}
                required
              />
              <Field
                label="State"
                name="region"
                maxLength={2}
                value={address.region}
                onChange={(e) =>
                  setAddress((a) => ({ ...a, region: e.target.value.toUpperCase() }))
                }
                error={fieldErrors['shippingAddress.region']}
                hint="Two letters"
                required
              />
              <Field
                label="ZIP code"
                name="postalCode"
                value={address.postalCode}
                onChange={(e) => setAddress((a) => ({ ...a, postalCode: e.target.value }))}
                error={fieldErrors['shippingAddress.postalCode']}
                required
              />
            </div>

            <p className="text-sm text-slate-500">We currently ship within the United States.</p>

            {error ? <Alert tone="error">{error}</Alert> : null}

            <Button type="submit" loading={busy}>
              Continue to delivery
            </Button>
          </form>
        ) : null}

        {checkout && checkout.shippingOptions.length > 0 ? (
          <section aria-labelledby="delivery-heading" className="space-y-3">
            <h2 id="delivery-heading" className="text-lg font-semibold text-slate-900">
              Delivery method
            </h2>

            <ul className="space-y-2">
              {checkout.shippingOptions.map((option) => (
                <li key={option.code}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 has-[:checked]:ring-2 has-[:checked]:ring-brand-500">
                    <input
                      type="radio"
                      name="shipping"
                      value={option.code}
                      checked={checkout.shippingMethodCode === option.code}
                      onChange={() => void chooseShipping(option.code)}
                      className="mt-1"
                    />
                    <span className="flex-1">
                      <span className="block font-medium text-slate-900">{option.name}</span>
                      {option.estimatedDaysMin !== null ? (
                        <span className="block text-sm text-slate-600">
                          {option.estimatedDaysMin}–{option.estimatedDaysMax} business days
                        </span>
                      ) : null}
                    </span>
                    <span className="font-medium text-slate-900">
                      {option.priceCents === 0
                        ? 'Free'
                        : formatMoney(option.priceCents, checkout.currency)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {checkout?.shippingMethodCode ? (
          <section aria-labelledby="payment-heading" className="space-y-3">
            <h2 id="payment-heading" className="text-lg font-semibold text-slate-900">
              Payment
            </h2>

            {checkout.payment && !checkout.payment.isRealMoney ? (
              <Alert tone="warning" title="This is a test environment">
                No real payment will be taken and no card details are collected. Orders placed here
                are not real orders.
              </Alert>
            ) : null}

            {error ? <Alert tone="error">{error}</Alert> : null}

            <Button
              size="lg"
              loading={busy}
              disabled={step === 'placing'}
              onClick={() => void pay()}
            >
              {step === 'placing'
                ? 'Placing your order…'
                : `Pay ${formatMoney(totals.totalCents, totals.currency)}`}
            </Button>

            <p className="text-xs text-slate-500">
              By placing this order you confirm you have read the warnings and disclaimers on each
              product page.
            </p>
          </section>
        ) : null}
      </div>

      <aside className="h-fit rounded-xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="text-base font-semibold text-slate-900">Order summary</h2>

        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {cart.lines.map((line) => (
            <li key={line.id} className="flex justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-slate-800">{line.productName}</span>
                <span className="text-xs text-slate-500">Qty {line.quantity}</span>
              </span>
              <span className="shrink-0 text-slate-900">
                {formatMoney(line.lineSubtotalCents, line.currency)}
              </span>
            </li>
          ))}
        </ul>

        <dl className="mt-4 space-y-2 border-t border-slate-200 pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-600">Subtotal</dt>
            <dd className="text-slate-900">{formatMoney(totals.subtotalCents, totals.currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-600">Delivery</dt>
            <dd className="text-slate-900">
              {checkout?.shippingMethodCode
                ? formatMoney(totals.shippingCents, totals.currency)
                : '—'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-600">Tax</dt>
            <dd className="text-slate-900">
              {/* "Not calculated" and "no tax" are different facts, and the API
                  distinguishes them, so the page does too. */}
              {totals.taxRateApplied === null
                ? checkout
                  ? 'Not applicable'
                  : '—'
                : formatMoney(totals.taxCents, totals.currency)}
            </dd>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
            <dt className="text-slate-900">Total</dt>
            <dd className="text-slate-900">{formatMoney(totals.totalCents, totals.currency)}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
