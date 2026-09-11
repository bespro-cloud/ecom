'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Creating a product.
 *
 * It is always created as a draft. There is no status field on this form and
 * none on the endpoint behind it — a new listing cannot be publicly visible in
 * one step, whatever the request says.
 *
 * The slug is suggested from the name and then left alone once it has been
 * edited. It goes into a public URL, so guessing at it after the fact would
 * mean silently changing someone's deliberate choice.
 */

const TYPES = ['SUPPLEMENT', 'COSMETIC', 'FOOD', 'DEVICE', 'WELLNESS', 'ACCESSORY'];

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      // Strip the combining marks NFKD just separated out.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
  );
}

export function NewProductForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    sku: '',
    name: '',
    slug: '',
    type: 'SUPPLEMENT',
    shortDescription: '',
    brand: '',
    manufacturer: '',
    countryOfOrigin: 'US',
    price: '',
  });
  const [slugEdited, setSlugEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function setName(value: string): void {
    setForm((current) => ({
      ...current,
      name: value,
      slug: slugEdited ? current.slug : slugify(value),
    }));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const created = await clientRequest<{ id: string }>('/api/v1/admin/catalogue/products', {
        method: 'POST',
        body: {
          sku: form.sku.trim().toUpperCase(),
          name: form.name.trim(),
          slug: form.slug.trim(),
          type: form.type,
          shortDescription: form.shortDescription.trim() || undefined,
          brand: form.brand.trim() || undefined,
          manufacturer: form.manufacturer.trim() || undefined,
          countryOfOrigin: form.countryOfOrigin.trim().toUpperCase() || undefined,
          priceCents: Math.round(Number(form.price) * 100),
        },
      });
      router.push(`/catalogue/${created.id}`);
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="SKU"
          name="sku"
          value={form.sku}
          onChange={(event) => setForm((c) => ({ ...c, sku: event.target.value.toUpperCase() }))}
          error={fieldErrors.sku}
          hint="Never reused. It appears on invoices, manifests and historical orders."
          required
        />
        <SelectField
          label="Product type"
          name="type"
          value={form.type}
          onChange={(event) => setForm((c) => ({ ...c, type: event.target.value }))}
          error={fieldErrors.type}
          hint="Decides which disclaimers and label checks apply."
        >
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {type.toLowerCase()}
            </option>
          ))}
        </SelectField>
        <Field
          label="Name"
          name="name"
          value={form.name}
          onChange={(event) => setName(event.target.value)}
          error={fieldErrors.name}
          required
        />
        <Field
          label="URL slug"
          name="slug"
          value={form.slug}
          onChange={(event) => {
            setSlugEdited(true);
            setForm((c) => ({ ...c, slug: event.target.value }));
          }}
          error={fieldErrors.slug}
          required
        />
        <Field
          label="Brand"
          name="brand"
          value={form.brand}
          onChange={(event) => setForm((c) => ({ ...c, brand: event.target.value }))}
          error={fieldErrors.brand}
        />
        <Field
          label="Manufacturer"
          name="manufacturer"
          value={form.manufacturer}
          onChange={(event) => setForm((c) => ({ ...c, manufacturer: event.target.value }))}
          error={fieldErrors.manufacturer}
        />
        <Field
          label="Country of origin"
          name="countryOfOrigin"
          value={form.countryOfOrigin}
          maxLength={2}
          onChange={(event) =>
            setForm((c) => ({ ...c, countryOfOrigin: event.target.value.toUpperCase() }))
          }
          error={fieldErrors.countryOfOrigin}
        />
        <Field
          label="Price"
          name="price"
          type="number"
          step="0.01"
          min={0}
          value={form.price}
          onChange={(event) => setForm((c) => ({ ...c, price: event.target.value }))}
          error={fieldErrors.priceCents}
          required
        />
      </div>

      <TextareaField
        rows={2}
        label="Short description"
        name="shortDescription"
        value={form.shortDescription}
        onChange={(event) => setForm((c) => ({ ...c, shortDescription: event.target.value }))}
        error={fieldErrors.shortDescription}
        hint="Say what the product is. What it does is a claim, and claims are reviewed separately."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Alert tone="info">
        The product is created as a draft. Ingredients, images, categories and search metadata are
        added on the next screen, and it becomes visible to customers only by passing the publishing
        checklist.
      </Alert>

      <Button type="submit" loading={saving}>
        Create draft
      </Button>
    </form>
  );
}
