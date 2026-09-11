'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';
import type { AdminCategory } from '@/lib/catalogue';

/**
 * Creating a category.
 *
 * The parent list is the existing tree. Nesting is capped server-side — five
 * levels — because navigation deeper than that stops being usable and every
 * level multiplies the breadcrumb and facet work. The form does not try to
 * enforce that itself; it reports what the server said.
 */
export function CategoryForm({ categories }: { categories: AdminCategory[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ slug: '', name: '', description: '', parentId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await clientRequest('/api/v1/admin/catalogue/categories', {
        method: 'POST',
        body: {
          slug: form.slug.trim(),
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          parentId: form.parentId || null,
        },
      });
      setForm({ slug: '', name: '', description: '', parentId: '' });
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
      <SelectField
        label="Parent"
        name="parentId"
        value={form.parentId}
        onChange={(event) => setForm((c) => ({ ...c, parentId: event.target.value }))}
        error={fieldErrors.parentId}
      >
        <option value="">No parent (top level)</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {'— '.repeat(category.depth)}
            {category.name}
          </option>
        ))}
      </SelectField>
      <TextareaField
        rows={3}
        label="Description"
        name="description"
        value={form.description}
        onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))}
        error={fieldErrors.description}
        hint="Shown at the top of the category page."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" loading={saving}>
        Create category
      </Button>
    </form>
  );
}
