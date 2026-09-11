'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Adding a warehouse.
 *
 * A warehouse is where stock physically is, and its address is what shipping
 * rates and (later) tax are calculated from. Creating one does not create
 * stock: quantities only ever move through an adjustment, which carries a
 * reason into the append-only ledger.
 */
export function WarehouseForm({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    code: '',
    name: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: 'US',
    priority: '0',
  });
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!canManage) {
    return (
      <p className="text-sm text-slate-500">
        Adding a warehouse needs the <code className="font-mono">INVENTORY_ADJUST</code> permission.
      </p>
    );
  }

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest('/api/v1/admin/commerce/warehouses', {
        method: 'POST',
        body: {
          code: values.code.trim(),
          name: values.name.trim(),
          line1: values.line1.trim(),
          ...(values.line2.trim() ? { line2: values.line2.trim() } : {}),
          city: values.city.trim(),
          region: values.region.trim(),
          postalCode: values.postalCode.trim(),
          country: values.country.trim(),
          priority: Number.parseInt(values.priority, 10) || 0,
          isActive,
        },
      });
      setOpen(false);
      setValues({
        code: '',
        name: '',
        line1: '',
        line2: '',
        city: '',
        region: '',
        postalCode: '',
        country: 'US',
        priority: '0',
      });
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
    return <Button onClick={() => setOpen(true)}>Add a warehouse</Button>;
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
          hint="Short and permanent, e.g. SLC."
          maxLength={20}
          required
        />
        <Field
          label="Name"
          name="name"
          value={values.name}
          onChange={set('name')}
          error={fieldErrors.name}
          maxLength={120}
          required
        />
      </div>

      <Field
        label="Address line 1"
        name="line1"
        value={values.line1}
        onChange={set('line1')}
        error={fieldErrors.line1}
        maxLength={200}
        required
      />
      <Field
        label="Address line 2"
        name="line2"
        value={values.line2}
        onChange={set('line2')}
        error={fieldErrors.line2}
        maxLength={200}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <Field
          label="City"
          name="city"
          value={values.city}
          onChange={set('city')}
          error={fieldErrors.city}
          maxLength={100}
          required
        />
        <Field
          label="State"
          name="region"
          value={values.region}
          onChange={set('region')}
          error={fieldErrors.region}
          maxLength={2}
          hint="Two letters"
          required
        />
        <Field
          label="Postal code"
          name="postalCode"
          value={values.postalCode}
          onChange={set('postalCode')}
          error={fieldErrors.postalCode}
          maxLength={20}
          required
        />
        <Field
          label="Country"
          name="country"
          value={values.country}
          onChange={set('country')}
          error={fieldErrors.country}
          maxLength={2}
          required
        />
      </div>

      <Field
        label="Allocation priority"
        name="priority"
        type="number"
        min={0}
        value={values.priority}
        onChange={set('priority')}
        error={fieldErrors.priority}
        hint="Lower numbers are drawn from first when an order is allocated."
      />

      <Checkbox
        label="Active"
        name="isActive"
        checked={isActive}
        onChange={(event) => setIsActive(event.target.checked)}
        hint="Inactive warehouses hold stock but are never allocated from."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex gap-2">
        <Button type="submit" loading={saving}>
          Create warehouse
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
