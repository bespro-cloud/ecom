'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Creating a discount code.
 *
 * The money fields are entered in whole currency units and converted to minor
 * units here, once, on submit — the API only ever receives integers. A
 * percentage is sent in basis points for the same reason: 12.5% is 1250, not a
 * float that rounds differently on two machines.
 *
 * The per-customer limit is disabled unless the code requires a signed-in
 * customer, because there is nobody to count a guest's redemptions against.
 * The API refuses the combination too — this just explains it before the
 * refusal.
 */
export function CouponForm() {
  const router = useRouter();
  const [type, setType] = useState('PERCENTAGE');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [percent, setPercent] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [maxPerCustomer, setMaxPerCustomer] = useState('');
  const [requiresCustomer, setRequiresCustomer] = useState(false);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** Whole units to minor units, without ever touching a float in transit. */
  function cents(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return Math.round(Number(trimmed) * 100);
  }

  function count(value: string): number | undefined {
    const trimmed = value.trim();
    return trimmed ? Number(trimmed) : undefined;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const body: Record<string, unknown> = {
      code: code.trim().toUpperCase(),
      name: name.trim(),
      type,
      requiresCustomer,
      isActive: true,
    };
    if (description.trim()) body.description = description.trim();
    if (type === 'FIXED_AMOUNT') body.amountCents = cents(amount);
    if (type === 'PERCENTAGE') {
      const percentage = Number(percent.trim());
      body.basisPoints = Number.isFinite(percentage) ? Math.round(percentage * 100) : undefined;
    }
    if (cents(minSubtotal) !== undefined) body.minSubtotalCents = cents(minSubtotal);
    if (cents(maxDiscount) !== undefined) body.maxDiscountCents = cents(maxDiscount);
    if (count(maxRedemptions) !== undefined) body.maxRedemptions = count(maxRedemptions);
    if (count(maxPerCustomer) !== undefined) body.maxPerCustomer = count(maxPerCustomer);
    if (startsAt) body.startsAt = new Date(startsAt).toISOString();
    if (endsAt) body.endsAt = new Date(endsAt).toISOString();

    try {
      await clientRequest('/api/v1/admin/lifecycle/coupons', { method: 'POST', body });
      router.refresh();
      setCode('');
      setName('');
      setDescription('');
      setAmount('');
      setPercent('');
      setBusy(false);
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('We could not create that code. Please try again.');
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Code"
          required
          value={code}
          maxLength={40}
          autoCapitalize="characters"
          error={fieldErrors.code}
          hint="Letters, numbers, hyphens and underscores."
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />
        <Field
          label="Internal name"
          required
          value={name}
          maxLength={120}
          error={fieldErrors.name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <TextareaField
        label="Description"
        rows={2}
        value={description}
        maxLength={500}
        error={fieldErrors.description}
        onChange={(event) => setDescription(event.target.value)}
      />

      <SelectField
        label="What it does"
        required
        value={type}
        error={fieldErrors.type}
        onChange={(event) => setType(event.target.value)}
      >
        <option value="PERCENTAGE">A percentage off</option>
        <option value="FIXED_AMOUNT">A fixed amount off</option>
        <option value="FREE_SHIPPING">Free delivery</option>
      </SelectField>

      <div className="grid gap-4 sm:grid-cols-2">
        {type === 'PERCENTAGE' ? (
          <Field
            label="Percentage off"
            required
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            value={percent}
            error={fieldErrors.basisPoints}
            hint="Rounded down to the nearest cent when applied, never up."
            onChange={(event) => setPercent(event.target.value)}
          />
        ) : null}

        {type === 'FIXED_AMOUNT' ? (
          <Field
            label="Amount off"
            required
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            error={fieldErrors.amountCents}
            onChange={(event) => setAmount(event.target.value)}
          />
        ) : null}

        {type === 'PERCENTAGE' ? (
          <Field
            label="Cap the discount at"
            type="number"
            min="0.01"
            step="0.01"
            value={maxDiscount}
            error={fieldErrors.maxDiscountCents}
            hint="Optional."
            onChange={(event) => setMaxDiscount(event.target.value)}
          />
        ) : null}

        <Field
          label="Minimum basket"
          type="number"
          min="0"
          step="0.01"
          value={minSubtotal}
          error={fieldErrors.minSubtotalCents}
          hint="Optional."
          onChange={(event) => setMinSubtotal(event.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Total uses allowed"
          type="number"
          min="1"
          value={maxRedemptions}
          error={fieldErrors.maxRedemptions}
          hint="Optional. Enforced by counting redemptions under a lock, so two checkouts cannot both take the last one."
          onChange={(event) => setMaxRedemptions(event.target.value)}
        />
        <Field
          label="Uses per customer"
          type="number"
          min="1"
          value={maxPerCustomer}
          disabled={!requiresCustomer}
          error={fieldErrors.maxPerCustomer}
          hint={
            requiresCustomer
              ? 'Optional.'
              : 'Needs “requires a signed-in customer” — there is nobody to count a guest against.'
          }
          onChange={(event) => setMaxPerCustomer(event.target.value)}
        />
      </div>

      <Checkbox
        label="Only usable by a signed-in customer"
        checked={requiresCustomer}
        onChange={(event) => {
          setRequiresCustomer(event.target.checked);
          if (!event.target.checked) setMaxPerCustomer('');
        }}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Starts"
          type="datetime-local"
          value={startsAt}
          error={fieldErrors.startsAt}
          onChange={(event) => setStartsAt(event.target.value)}
        />
        <Field
          label="Ends"
          type="datetime-local"
          value={endsAt}
          error={fieldErrors.endsAt}
          onChange={(event) => setEndsAt(event.target.value)}
        />
      </div>

      <Button type="submit" loading={busy} loadingLabel="Creating…">
        Create code
      </Button>
    </form>
  );
}
