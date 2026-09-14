'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

/**
 * Drafting a post.
 *
 * The body is Markdown inside a typed block, never raw HTML — the same
 * vocabulary CMS pages use, for the same reason: an editor that accepts HTML
 * eventually stores a script tag, whether through a compromised account or a
 * well-meant paste.
 *
 * The product list is the field that decides whether this post needs compliance
 * sign-off, and the form says so plainly rather than leaving the writer to
 * discover it when publishing is refused.
 */
export function BlogPostForm() {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [productIds, setProductIds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const products = productIds
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const created = await clientRequest<{ id: string }>('/api/v1/admin/growth/blog/posts', {
        method: 'POST',
        body: {
          slug: slug.trim(),
          title: title.trim(),
          ...(excerpt.trim() ? { excerpt: excerpt.trim() } : {}),
          blocks: markdown.trim()
            ? [{ id: 'body', type: 'richText', markdown: markdown.trim() }]
            : [],
          productIds: products,
        },
      });
      router.push(`/blog/${created.id}`);
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('We could not save the post. Please try again.');
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Title"
          required
          value={title}
          maxLength={200}
          error={fieldErrors.title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Field
          label="URL slug"
          required
          value={slug}
          maxLength={200}
          error={fieldErrors.slug}
          hint="Renaming this later writes a redirect automatically."
          onChange={(event) => setSlug(event.target.value)}
        />
      </div>

      <TextareaField
        label="Excerpt"
        rows={2}
        value={excerpt}
        maxLength={400}
        error={fieldErrors.excerpt}
        hint="Shown on the index and used as the meta description."
        onChange={(event) => setExcerpt(event.target.value)}
      />

      <TextareaField
        label="Body"
        rows={14}
        value={markdown}
        error={fieldErrors.blocks}
        hint="Markdown. HTML is not accepted and would not render."
        onChange={(event) => setMarkdown(event.target.value)}
      />

      <Field
        label="Products this post is about"
        value={productIds}
        error={fieldErrors.productIds}
        hint="Product ids, separated by spaces or commas. Leave empty if the post discusses no specific product."
        onChange={(event) => setProductIds(event.target.value)}
      />

      {products.length > 0 ? (
        <Alert tone="warning" title="This post will need compliance sign-off">
          <p>
            Naming a product makes this marketing copy about a regulated product. A compliance
            reviewer will read the text before it can be published — you will not be able to publish
            it yourself, and neither will an administrator.
          </p>
        </Alert>
      ) : (
        <Alert tone="info" title="No compliance review needed">
          <p>
            This post names no product, so you can publish it yourself. Add a product above if the
            article discusses one — the review exists for claims about products, and declaring them
            is a judgement rather than something the system guesses from the prose.
          </p>
        </Alert>
      )}

      <Button type="submit" loading={busy} loadingLabel="Saving…">
        Save draft
      </Button>
    </form>
  );
}
