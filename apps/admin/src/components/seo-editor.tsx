'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * SEO metadata.
 *
 * Nothing here generates copy. A meta description is a public statement about a
 * health product, shown to people who never open the page, so it is written by
 * a person or it is empty. The character counters exist because a truncated
 * description is how a careful sentence becomes a misleading fragment.
 */

const TITLE_MAX = 70;
const DESCRIPTION_MAX = 160;

interface SeoValues {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  noindex: boolean;
}

export function SeoEditor({
  entityType,
  entityId,
  initial,
  canWrite,
}: {
  entityType: string;
  entityId: string;
  initial: SeoValues | null;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    canonicalUrl: initial?.canonicalUrl ?? '',
    noindex: initial?.noindex ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);

    try {
      await clientRequest(`/api/v1/content/admin/seo/${entityType}/${entityId}`, {
        method: 'PUT',
        body: {
          title: form.title || null,
          description: form.description || null,
          canonicalUrl: form.canonicalUrl || null,
          noindex: form.noindex,
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
        <h2 className="text-lg font-semibold text-slate-900">Search metadata</h2>
        <p className="mt-2 text-sm text-slate-600">{initial?.title ?? 'Not set.'}</p>
        <p className="mt-1 text-sm text-slate-500">{initial?.description ?? ''}</p>
      </div>
    );
  }

  return (
    <form onSubmit={save} noValidate>
      <h2 className="text-lg font-semibold text-slate-900">Search metadata</h2>
      <p className="mt-1 text-sm text-slate-600">
        This is what appears in search results, read by people who never open the page. It is
        written here by a person — nothing generates it.
      </p>

      <div className="mt-4 space-y-4">
        <Field
          label="Title"
          name="seoTitle"
          value={form.title}
          maxLength={TITLE_MAX}
          onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
          error={fieldErrors.title}
          hint={`${form.title.length} of ${TITLE_MAX} characters. Longer titles are truncated by search engines.`}
        />
        <TextareaField
          rows={3}
          label="Description"
          name="seoDescription"
          value={form.description}
          maxLength={DESCRIPTION_MAX}
          onChange={(event) =>
            setForm((current) => ({ ...current, description: event.target.value }))
          }
          error={fieldErrors.description}
          hint={`${form.description.length} of ${DESCRIPTION_MAX} characters. A truncated sentence is how careful wording becomes a misleading fragment.`}
        />
        <Field
          label="Canonical URL"
          name="canonicalUrl"
          type="url"
          value={form.canonicalUrl}
          onChange={(event) =>
            setForm((current) => ({ ...current, canonicalUrl: event.target.value }))
          }
          error={fieldErrors.canonicalUrl}
          hint="Only when this page duplicates another. Leave empty otherwise."
        />
        <Checkbox
          label="Keep out of search results"
          name="noindex"
          checked={form.noindex}
          onChange={(event) =>
            setForm((current) => ({ ...current, noindex: event.target.checked }))
          }
          hint="Excludes the page from the sitemap and sets a noindex directive. Use it while something is being corrected."
        />
      </div>

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
          Save metadata
        </Button>
      </div>
    </form>
  );
}
