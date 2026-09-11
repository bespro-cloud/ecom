'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';
import type { AdminProduct } from '@/lib/catalogue';

/**
 * Editing a product's own fields.
 *
 * Prices are entered in whole currency units and converted to integer minor
 * units here, once, at the boundary. Nothing downstream sees a float — the
 * rounding happens in one place where it can be read, rather than being spread
 * across the form.
 *
 * Some of these fields are compliance-relevant. Changing the manufacturer,
 * country of origin or product type re-opens the approval and withdraws a live
 * listing; the form says so rather than letting it be a surprise.
 */

function toCents(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
}

function fromCents(value: number | null): string {
  return value === null ? '' : (value / 100).toFixed(2);
}

export function ProductEditor({ product, canWrite }: { product: AdminProduct; canWrite: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription ?? '',
    longDescription: product.longDescription ?? '',
    brand: product.brand ?? '',
    manufacturer: product.manufacturer ?? '',
    countryOfOrigin: product.countryOfOrigin ?? '',
    price: fromCents(product.priceCents),
    compareAtPrice: fromCents(product.compareAtPriceCents),
    weightGrams: product.weightGrams === null ? '' : String(product.weightGrams),
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const changedMaterial =
    (form.name !== product.name ||
      form.brand !== (product.brand ?? '') ||
      form.manufacturer !== (product.manufacturer ?? '') ||
      form.countryOfOrigin !== (product.countryOfOrigin ?? '')) &&
    product.complianceStatus === 'APPROVED';

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest(`/api/v1/admin/catalogue/products/${product.id}`, {
        method: 'PATCH',
        body: {
          name: form.name,
          slug: form.slug,
          shortDescription: form.shortDescription || null,
          longDescription: form.longDescription || null,
          brand: form.brand || null,
          manufacturer: form.manufacturer || null,
          countryOfOrigin: form.countryOfOrigin || null,
          priceCents: toCents(form.price),
          compareAtPriceCents:
            form.compareAtPrice.trim() === '' ? null : toCents(form.compareAtPrice),
          weightGrams: form.weightGrams.trim() === '' ? null : Number(form.weightGrams),
        },
      });
      setSaved(true);
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

  if (!canWrite) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Details</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Readonly label="Name" value={product.name} />
          <Readonly label="Slug" value={product.slug} />
          <Readonly label="Brand" value={product.brand} />
          <Readonly label="Manufacturer" value={product.manufacturer} />
          <Readonly label="Country of origin" value={product.countryOfOrigin} />
          <Readonly label="Short description" value={product.shortDescription} />
        </dl>
      </div>
    );
  }

  return (
    <form onSubmit={save} noValidate>
      <h2 className="text-lg font-semibold text-slate-900">Details</h2>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="name"
          value={form.name}
          onChange={(event) => set('name')(event.target.value)}
          error={fieldErrors.name}
          required
        />
        <Field
          label="URL slug"
          name="slug"
          value={form.slug}
          onChange={(event) => set('slug')(event.target.value)}
          error={fieldErrors.slug}
          hint="Changing this changes the public URL. Old links will stop working."
          required
        />
        <Field
          label="Brand"
          name="brand"
          value={form.brand}
          onChange={(event) => set('brand')(event.target.value)}
          error={fieldErrors.brand}
        />
        <Field
          label="Manufacturer"
          name="manufacturer"
          value={form.manufacturer}
          onChange={(event) => set('manufacturer')(event.target.value)}
          error={fieldErrors.manufacturer}
        />
        <Field
          label="Country of origin"
          name="countryOfOrigin"
          value={form.countryOfOrigin}
          onChange={(event) => set('countryOfOrigin')(event.target.value.toUpperCase())}
          error={fieldErrors.countryOfOrigin}
          hint="Two-letter ISO code, e.g. US."
          maxLength={2}
        />
        <Field
          label="Net weight (grams)"
          name="weightGrams"
          type="number"
          min={0}
          value={form.weightGrams}
          onChange={(event) => set('weightGrams')(event.target.value)}
          error={fieldErrors.weightGrams}
        />
        <Field
          label="Price"
          name="price"
          type="number"
          step="0.01"
          min={0}
          value={form.price}
          onChange={(event) => set('price')(event.target.value)}
          error={fieldErrors.priceCents}
          required
        />
        <Field
          label="Compare-at price"
          name="compareAtPrice"
          type="number"
          step="0.01"
          min={0}
          value={form.compareAtPrice}
          onChange={(event) => set('compareAtPrice')(event.target.value)}
          error={fieldErrors.compareAtPriceCents}
          hint="Leave empty unless it was genuinely sold at this price. It must be higher than the price."
        />
      </div>

      <div className="mt-4 space-y-4">
        <TextareaField
          rows={2}
          label="Short description"
          name="shortDescription"
          value={form.shortDescription}
          onChange={(event) => set('shortDescription')(event.target.value)}
          error={fieldErrors.shortDescription}
          hint="Shown on listing cards. Say what the product is, not what it does."
        />
        <TextareaField
          rows={6}
          label="Full description"
          name="longDescription"
          value={form.longDescription}
          onChange={(event) => set('longDescription')(event.target.value)}
          error={fieldErrors.longDescription}
          hint="Plain text. Health claims belong to a reviewed claim record, not to product copy."
        />
      </div>

      {changedMaterial ? (
        <Alert tone="warning" className="mt-4" title="This will re-open the compliance approval">
          You have changed a field the reviewer signed off on. Saving sets the compliance status
          back to not reviewed, and takes the listing out of sale if it is live.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="success" className="mt-4">
          Saved.
        </Alert>
      ) : null}

      <div className="mt-4">
        <Button type="submit" loading={saving}>
          Save details
        </Button>
      </div>
    </form>
  );
}

function Readonly({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value ?? '—'}</dd>
    </>
  );
}
