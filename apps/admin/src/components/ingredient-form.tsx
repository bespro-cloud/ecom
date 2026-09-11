'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Adding an ingredient.
 *
 * The allergen name is a separate field from the ingredient name because they
 * are different things: "Omega-3 fish oil" is the ingredient, "fish" is the
 * allergen that must be declared. The publishing checklist matches on the
 * declared allergen, and inferring it from the ingredient name would be exactly
 * the kind of plausible guess that must not reach a label.
 */
export function IngredientForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    slug: '',
    name: '',
    scientificName: '',
    description: '',
    isAllergen: false,
    allergen: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest('/api/v1/admin/catalogue/ingredients', {
        method: 'POST',
        body: {
          slug: form.slug.trim(),
          name: form.name.trim(),
          scientificName: form.scientificName.trim() || undefined,
          description: form.description.trim() || undefined,
          isAllergen: form.isAllergen,
          allergen: form.isAllergen ? form.allergen.trim() || undefined : undefined,
        },
      });
      setForm({
        slug: '',
        name: '',
        scientificName: '',
        description: '',
        isAllergen: false,
        allergen: '',
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

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label="Name"
        name="name"
        value={form.name}
        onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
        error={fieldErrors.name}
        required
      />
      <Field
        label="URL slug"
        name="slug"
        value={form.slug}
        onChange={(event) => setForm((c) => ({ ...c, slug: event.target.value }))}
        error={fieldErrors.slug}
        required
      />
      <Field
        label="Scientific name"
        name="scientificName"
        value={form.scientificName}
        onChange={(event) => setForm((c) => ({ ...c, scientificName: event.target.value }))}
        error={fieldErrors.scientificName}
      />
      <TextareaField
        rows={3}
        label="Description"
        name="description"
        value={form.description}
        onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))}
        error={fieldErrors.description}
        hint="What it is and where it comes from. Not what it does."
      />

      <Checkbox
        label="This is a declared allergen"
        name="isAllergen"
        checked={form.isAllergen}
        onChange={(event) => setForm((c) => ({ ...c, isAllergen: event.target.checked }))}
        hint="Listings containing it must carry an allergen disclaimer or a warning that names it."
      />

      {form.isAllergen ? (
        <Field
          label="Allergen name"
          name="allergen"
          value={form.allergen}
          onChange={(event) => setForm((c) => ({ ...c, allergen: event.target.value }))}
          error={fieldErrors.allergen}
          hint="The word as it must be declared — “fish”, “soy”, “sesame” — not the ingredient name."
          required
        />
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" loading={saving}>
        Add ingredient
      </Button>
    </form>
  );
}
