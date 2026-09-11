'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';
import type { AdminPage } from '@/lib/catalogue';

/**
 * The block editor.
 *
 * There is no rich-text surface here, and that is the point. Content is a fixed
 * set of typed blocks, so there is no field into which HTML could be pasted and
 * later rendered — stored XSS is structurally impossible rather than filtered.
 * Rich text is a small Markdown subset, rendered by the storefront into React
 * elements; markup in it comes out as visible characters.
 *
 * Editing a published page writes only to the draft columns. The live page a
 * customer is reading does not change until someone publishes, so saving a
 * half-finished edit to the shipping policy does not change the shipping
 * policy.
 */

type Block = Record<string, unknown> & { id: string; type: string };

const BLOCK_TYPES = [
  { value: 'heading', label: 'Heading' },
  { value: 'richText', label: 'Text' },
  { value: 'callout', label: 'Callout' },
  { value: 'faq', label: 'Questions and answers' },
];

function newBlock(type: string): Block {
  const id = `block-${Math.random().toString(36).slice(2, 10)}`;
  switch (type) {
    case 'heading':
      return { id, type, level: 2, text: '' };
    case 'callout':
      return { id, type, tone: 'info', title: '', markdown: '' };
    case 'faq':
      return { id, type, items: [{ question: '', answer: '' }] };
    default:
      return { id, type: 'richText', markdown: '' };
  }
}

export function PageEditor({
  page,
  canWrite,
  canPublish,
}: {
  page: AdminPage;
  canWrite: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const source = page.draft ?? { title: page.title, blocks: page.blocks };

  const [title, setTitle] = useState(source.title);
  const [blocks, setBlocks] = useState<Block[]>(source.blocks as Block[]);
  const [addType, setAddType] = useState('richText');
  const [busy, setBusy] = useState<'save' | 'publish' | 'unpublish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isLive = page.status === 'PUBLISHED';

  function update(id: string, changes: Partial<Block>): void {
    setBlocks((current) =>
      current.map((block) => (block.id === id ? { ...block, ...changes } : block)),
    );
    setNotice(null);
  }

  function move(index: number, direction: -1 | 1): void {
    const next = index + direction;
    if (next < 0 || next >= blocks.length) return;
    setBlocks((current) => {
      const copy = [...current];
      const [moved] = copy.splice(index, 1);
      copy.splice(next, 0, moved!);
      return copy;
    });
  }

  async function save(): Promise<void> {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      await clientRequest(`/api/v1/content/admin/pages/${page.id}`, {
        method: 'PATCH',
        body: { title, blocks },
      });
      setNotice(
        isLive ? 'Saved as a draft. The live page is unchanged until you publish.' : 'Saved.',
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  async function publish(): Promise<void> {
    setBusy('publish');
    setError(null);
    setNotice(null);
    try {
      await clientRequest(`/api/v1/content/admin/pages/${page.id}/publish`, { method: 'POST' });
      setNotice('Published. This is what customers now see.');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  async function unpublish(reason: string): Promise<void> {
    setBusy('unpublish');
    setError(null);
    try {
      await clientRequest(`/api/v1/content/admin/pages/${page.id}/unpublish`, {
        method: 'POST',
        body: { reason },
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  if (!canWrite) {
    return (
      <Alert tone="info" title="You can read this page but not edit it">
        Editing needs the <code className="font-mono">CONTENT_WRITE</code> permission.
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {isLive ? (
        <Alert tone="info">
          This page is live. Saving writes a draft — the version customers are reading does not
          change until you publish.
        </Alert>
      ) : null}

      <Field
        label="Page title"
        name="title"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setNotice(null);
        }}
        required
      />

      <ol className="space-y-4">
        {blocks.map((block, index) => (
          <li key={block.id} className="rounded-lg bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">
                {BLOCK_TYPES.find((type) => type.value === block.type)?.label ?? block.type}
              </span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Move block up"
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === blocks.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move block down"
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setBlocks((current) => current.filter((entry) => entry.id !== block.id))
                  }
                  aria-label="Remove block"
                >
                  Remove
                </Button>
              </div>
            </div>

            <div className="mt-3">
              <BlockFields block={block} onChange={(changes) => update(block.id, changes)} />
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Add a block"
          name="addType"
          value={addType}
          onChange={(event) => setAddType(event.target.value)}
        >
          {BLOCK_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </SelectField>
        <Button
          variant="secondary"
          onClick={() => setBlocks((current) => [...current, newBlock(addType)])}
        >
          Add
        </Button>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
        <Button onClick={() => void save()} loading={busy === 'save'}>
          {isLive ? 'Save draft' : 'Save'}
        </Button>

        {canPublish ? (
          <>
            <Button
              variant="secondary"
              onClick={() => void publish()}
              loading={busy === 'publish'}
              disabled={blocks.length === 0}
            >
              {isLive ? 'Publish changes' : 'Publish'}
            </Button>
            {isLive ? <UnpublishButton onConfirm={unpublish} busy={busy === 'unpublish'} /> : null}
          </>
        ) : (
          <p className="self-center text-sm text-slate-500">
            Publishing needs the <code className="font-mono">CONTENT_PUBLISH</code> permission.
          </p>
        )}
      </div>
    </div>
  );
}

function UnpublishButton({
  onConfirm,
  busy,
}: {
  onConfirm: (reason: string) => Promise<void>;
  busy: boolean;
}) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Take offline
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-lg bg-slate-50 p-3">
      <Field
        label="Why is this page coming down?"
        name="unpublishReason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        hint="Recorded in the audit log."
      />
      <div className="flex gap-2">
        <Button
          variant="danger"
          loading={busy}
          disabled={reason.trim().length === 0}
          onClick={() => void onConfirm(reason.trim())}
        >
          Take offline
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BlockFields({
  block,
  onChange,
}: {
  block: Block;
  onChange: (changes: Partial<Block>) => void;
}) {
  switch (block.type) {
    case 'heading':
      return (
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <SelectField
            label="Level"
            name="level"
            value={String(block.level ?? 2)}
            onChange={(event) => onChange({ level: Number(event.target.value) })}
          >
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
            <option value="4">Heading 4</option>
          </SelectField>
          <Field
            label="Text"
            name="text"
            value={String(block.text ?? '')}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        </div>
      );

    case 'callout':
      return (
        <div className="space-y-3">
          <SelectField
            label="Tone"
            name="tone"
            value={String(block.tone ?? 'info')}
            onChange={(event) => onChange({ tone: event.target.value })}
          >
            <option value="info">Information</option>
            <option value="warning">Warning</option>
          </SelectField>
          <Field
            label="Title"
            name="calloutTitle"
            value={String(block.title ?? '')}
            onChange={(event) => onChange({ title: event.target.value })}
          />
          <TextareaField
            rows={3}
            label="Text"
            name="calloutMarkdown"
            value={String(block.markdown ?? '')}
            onChange={(event) => onChange({ markdown: event.target.value })}
            hint="Markdown: **bold**, *italic*, [links](/path), and - bulleted lists."
          />
        </div>
      );

    case 'faq': {
      const items = (block.items as Array<{ question?: string; answer?: string }>) ?? [];
      return (
        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={index} className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200">
              <Field
                label="Question"
                name={`question-${index}`}
                value={item.question ?? ''}
                onChange={(event) =>
                  onChange({
                    items: items.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, question: event.target.value } : entry,
                    ),
                  })
                }
              />
              <TextareaField
                rows={3}
                label="Answer"
                name={`answer-${index}`}
                value={item.answer ?? ''}
                onChange={(event) =>
                  onChange({
                    items: items.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, answer: event.target.value } : entry,
                    ),
                  })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange({ items: items.filter((_, entryIndex) => entryIndex !== index) })
                }
              >
                Remove this question
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onChange({ items: [...items, { question: '', answer: '' }] })}
          >
            Add a question
          </Button>
        </div>
      );
    }

    default:
      return (
        <TextareaField
          rows={6}
          label="Text"
          name="markdown"
          value={String(block.markdown ?? '')}
          onChange={(event) => onChange({ markdown: event.target.value })}
          hint="Markdown: **bold**, *italic*, [links](/path), and - bulleted lists. HTML is not markup here — it shows as characters."
        />
      );
  }
}
