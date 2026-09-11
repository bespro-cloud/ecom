'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Creating a content page.
 *
 * It starts with a single heading block, because a page has to have content to
 * be created at all and an empty one cannot be published. The blocks are edited
 * on the page's own screen.
 */
export function NewPageForm() {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const created = await clientRequest<{ id: string }>('/api/v1/content/admin/pages', {
        method: 'POST',
        body: {
          slug: slug.trim(),
          title: title.trim(),
          blocks: [
            {
              id: `block-${Date.now().toString(36)}`,
              type: 'heading',
              level: 2,
              text: title.trim() || 'Untitled section',
            },
          ],
        },
      });
      router.push(`/content/${created.id}`);
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
      <Field
        label="Title"
        name="title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={fieldErrors.title}
        required
      />
      <Field
        label="URL slug"
        name="slug"
        value={slug}
        onChange={(event) => setSlug(event.target.value)}
        error={fieldErrors.slug}
        hint="The page will live at /pages/<slug>."
        required
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" loading={saving}>
        Create page
      </Button>
    </form>
  );
}
