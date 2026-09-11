'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Adding a shipping rate.
 *
 * Rates are configuration, not code: what delivery costs changes for commercial
 * reasons, and it should not need a deploy. They are also the *only* source of
 * the shipping figure on an order — the browser never sends one, and a quote
 * the customer accepted is re-derived server-side before anything is charged.
 *
 * Money is entered in dollars here for the operator's sake and converted to
 * integer cents before it leaves the browser. Nothing downstream ever sees a
 * fractional amount.
 */
export function ShippingRateForm({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    code: '',
    name: '',
    description: '',
    countries: 'US',
    regions: '',
    price: '',
    freeAbove: '',
    estimatedDaysMin: '',
    estimatedDaysMax: '',
    position: '0',
  });
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canManage) {
    return (
      <p className="text-sm text-slate-500">
        Changing shipping rates needs the <code className="font-mono">SYSTEM_SETTINGS</code>{' '}
        permission. What delivery costs is a commercial decision, kept separate from running orders.
      </p>
    );
  }

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  const toCents = (value: string): number | null => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
  };

  const toInt = (value: string): number | null => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  };

  const splitCodes = (value: string): string[] =>
    value
      .split(/[\s,]+/)
      .map((code) => code.trim())
      .filter(Boolean);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest('/api/v1/admin/commerce/shipping-rates', {
        method: 'POST',
        body: {
          code: values.code.trim(),
          name: values.name.trim(),
          ...(values.description.trim() ? { description: values.description.trim() } : {}),
          countries: splitCodes(values.countries),
          regions: splitCodes(values.regions),
          priceCents: toCents(values.price) ?? 0,
          freeAboveSubtotalCents: values.freeAbove ? toCents(values.freeAbove) : null,
          estimatedDaysMin: toInt(values.estimatedDaysMin),
          estimatedDaysMax: toInt(values.estimatedDaysMax),
          position: toInt(values.position) ?? 0,
          isActive,
        },
      });
      setOpen(false);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>Add a rate</Button>;
  }

  return (
    <form onSubmit={submit} noValidate className="max-w-xl space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Code"
          name="code"
          value={values.code}
          onChange={set('code')}
          error={fieldErrors.code}
          hint="Lowercase and permanent, e.g. standard."
          maxLength={60}
          required
        />
        <Field
          label="Name shown to customers"
          name="name"
          value={values.name}
          onChange={set('name')}
          error={fieldErrors.name}
          maxLength={120}
          required
        />
      </div>

      <Field
        label="Description"
        name="description"
        value={values.description}
        onChange={set('description')}
        error={fieldErrors.description}
        maxLength={500}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Countries"
          name="countries"
          value={values.countries}
          onChange={set('countries')}
          error={fieldErrors.countries}
          hint="Two-letter codes, comma separated."
          required
        />
        <Field
          label="States"
          name="regions"
          value={values.regions}
          onChange={set('regions')}
          error={fieldErrors.regions}
          hint="Leave blank for every state in those countries."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Price (USD)"
          name="priceCents"
          type="number"
          min="0"
          step="0.01"
          value={values.price}
          onChange={set('price')}
          error={fieldErrors.priceCents}
          required
        />
        <Field
          label="Free above subtotal (USD)"
          name="freeAboveSubtotalCents"
          type="number"
          min="0"
          step="0.01"
          value={values.freeAbove}
          onChange={set('freeAbove')}
          error={fieldErrors.freeAboveSubtotalCents}
          hint="Leave blank for never free."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Fastest (days)"
          name="estimatedDaysMin"
          type="number"
          min={0}
          value={values.estimatedDaysMin}
          onChange={set('estimatedDaysMin')}
          error={fieldErrors.estimatedDaysMin}
        />
        <Field
          label="Slowest (days)"
          name="estimatedDaysMax"
          type="number"
          min={0}
          value={values.estimatedDaysMax}
          onChange={set('estimatedDaysMax')}
          error={fieldErrors.estimatedDaysMax}
        />
        <Field
          label="Position"
          name="position"
          type="number"
          min={0}
          value={values.position}
          onChange={set('position')}
          error={fieldErrors.position}
          hint="Lower shows first."
        />
      </div>

      <Checkbox
        label="Active"
        name="isActive"
        checked={isActive}
        onChange={(event) => setIsActive(event.target.checked)}
        hint="Inactive rates are never offered at checkout, but stay on the orders that used them."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex gap-2">
        <Button type="submit" loading={saving}>
          Create rate
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
