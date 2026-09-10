'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, SelectField } from '@health/ui';
import { US_STATE_CODES } from '@health/validation';
import { clientRequest, ClientApiError } from '@/lib/client';

export interface Address {
  id: string;
  type: string;
  label: string | null;
  firstName: string;
  lastName: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string | null;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}

export function AddressBook({ initial }: { initial: Address[] }) {
  const router = useRouter();
  const [addresses, setAddresses] = useState(initial);
  const [adding, setAdding] = useState(initial.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function remove(id: string): Promise<void> {
    setError(null);
    setRemovingId(id);
    try {
      await clientRequest(`/api/v1/me/addresses/${id}`, { method: 'DELETE' });
      setAddresses((current) => current.filter((address) => address.id !== id));
      router.refresh();
    } catch {
      setError('We could not remove that address. Please try again.');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <Alert tone="error">{error}</Alert> : null}

      {addresses.length === 0 && !adding ? (
        <EmptyState
          title="No saved addresses"
          description="Add an address now and it will be ready at checkout."
          action={<Button onClick={() => setAdding(true)}>Add an address</Button>}
        />
      ) : null}

      {addresses.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {addresses.map((address) => (
            <li key={address.id}>
              <Card className="flex h-full flex-col justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    {address.label ? (
                      <span className="text-sm font-semibold text-slate-900">{address.label}</span>
                    ) : null}
                    {address.isDefaultShipping ? (
                      <Badge tone="success">Default shipping</Badge>
                    ) : null}
                    {address.isDefaultBilling ? <Badge tone="info">Default billing</Badge> : null}
                  </div>
                  <address className="mt-2 text-sm not-italic leading-relaxed text-slate-700">
                    {address.firstName} {address.lastName}
                    <br />
                    {address.company ? (
                      <>
                        {address.company}
                        <br />
                      </>
                    ) : null}
                    {address.line1}
                    <br />
                    {address.line2 ? (
                      <>
                        {address.line2}
                        <br />
                      </>
                    ) : null}
                    {address.city}, {address.region} {address.postalCode}
                    <br />
                    {address.country}
                  </address>
                </div>
                <div className="mt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={removingId === address.id}
                    loadingLabel="Removing…"
                    onClick={() => void remove(address.id)}
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Add an address</h2>
          <div className="mt-4">
            <AddressForm
              onCancel={addresses.length > 0 ? () => setAdding(false) : undefined}
              onSaved={(address) => {
                setAddresses((current) => [
                  address,
                  // A new default demotes the previous one server-side; mirror
                  // that here so the list does not briefly show two.
                  ...current.map((existing) => ({
                    ...existing,
                    isDefaultShipping: address.isDefaultShipping
                      ? false
                      : existing.isDefaultShipping,
                    isDefaultBilling: address.isDefaultBilling ? false : existing.isDefaultBilling,
                  })),
                ]);
                setAdding(false);
                router.refresh();
              }}
            />
          </div>
        </Card>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Add another address
        </Button>
      )}
    </div>
  );
}

function AddressForm({
  onSaved,
  onCancel,
}: {
  onSaved: (address: Address) => void;
  onCancel?: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    const data = new FormData(event.currentTarget);
    const body = {
      label: emptyToUndefined(data.get('label')),
      firstName: String(data.get('firstName') ?? ''),
      lastName: String(data.get('lastName') ?? ''),
      company: emptyToUndefined(data.get('company')),
      line1: String(data.get('line1') ?? ''),
      line2: emptyToUndefined(data.get('line2')),
      city: String(data.get('city') ?? ''),
      region: String(data.get('region') ?? ''),
      postalCode: String(data.get('postalCode') ?? ''),
      country: 'US',
      isDefaultShipping: data.get('isDefaultShipping') === 'on',
      isDefaultBilling: data.get('isDefaultBilling') === 'on',
    };

    try {
      const saved = await clientRequest<Address>('/api/v1/me/addresses', { method: 'POST', body });
      onSaved(saved);
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        if (Object.keys(caught.fieldErrors).length === 0) setError(caught.message);
      } else {
        setError('We could not save that address. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Field
        label="Label"
        name="label"
        placeholder="Home"
        hint="Optional — helps you tell addresses apart."
        error={fieldErrors.label}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="First name"
          name="firstName"
          autoComplete="given-name"
          required
          error={fieldErrors.firstName}
        />
        <Field
          label="Last name"
          name="lastName"
          autoComplete="family-name"
          required
          error={fieldErrors.lastName}
        />
      </div>

      <Field
        label="Company"
        name="company"
        autoComplete="organization"
        error={fieldErrors.company}
      />
      <Field
        label="Street address"
        name="line1"
        autoComplete="address-line1"
        required
        error={fieldErrors.line1}
      />
      <Field
        label="Apartment, suite, etc."
        name="line2"
        autoComplete="address-line2"
        error={fieldErrors.line2}
      />

      <div className="grid gap-5 sm:grid-cols-3">
        <Field
          label="City"
          name="city"
          autoComplete="address-level2"
          required
          error={fieldErrors.city}
          className="sm:col-span-1"
        />
        <SelectField
          label="State"
          name="region"
          autoComplete="address-level1"
          required
          defaultValue=""
          error={fieldErrors.region}
        >
          <option value="" disabled>
            Select…
          </option>
          {US_STATE_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </SelectField>
        <Field
          label="ZIP code"
          name="postalCode"
          autoComplete="postal-code"
          inputMode="numeric"
          required
          error={fieldErrors.postalCode}
        />
      </div>

      <Checkbox name="isDefaultShipping" label="Use as my default shipping address" />
      <Checkbox name="isDefaultBilling" label="Use as my default billing address" />

      <div className="flex gap-3">
        <Button type="submit" loading={submitting} loadingLabel="Saving…">
          Save address
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : undefined;
}
