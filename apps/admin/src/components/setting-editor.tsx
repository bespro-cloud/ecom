'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';
import type { SystemSetting } from '@/app/settings/page';

/**
 * Values are edited as text and parsed according to the setting's declared
 * type. The API rejects a type change outright — a number the code does
 * arithmetic on must not silently become a string.
 */
export function SettingEditor({ setting }: { setting: SystemSetting }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => stringify(setting.value, setting.valueType));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setError(null);
    let parsed: unknown;
    try {
      parsed = parse(draft, setting.valueType);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That value could not be read.');
      return;
    }

    setBusy(true);
    try {
      await clientRequest(`/api/v1/system/settings/${encodeURIComponent(setting.key)}`, {
        method: 'PUT',
        body: { value: parsed, reason },
      });
      setEditing(false);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'Could not save the setting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-medium text-slate-900">{setting.key}</p>
          {setting.description ? (
            <p className="mt-0.5 max-w-2xl text-sm text-slate-600">{setting.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge>{setting.valueType}</Badge>
          <Button size="sm" variant="ghost" onClick={() => setEditing((current) => !current)}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
        </div>
      </div>

      {!editing ? (
        <pre className="mt-2 overflow-x-auto rounded bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {stringify(setting.value, setting.valueType)}
        </pre>
      ) : (
        <div className="mt-3 space-y-3">
          {error ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}

          <label className="block text-sm">
            <span className="font-medium text-slate-900">Value</span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={setting.valueType === 'JSON' ? 4 : 1}
              className="mt-1 block w-full rounded-lg border-0 px-3 py-2 font-mono text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-brand-600"
            />
          </label>

          <label className="block text-sm">
            <span className="font-medium text-slate-900">Reason for the change</span>
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={5}
              className="mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-brand-600"
            />
          </label>

          <Button
            size="sm"
            loading={busy}
            loadingLabel="Saving…"
            disabled={reason.trim().length < 5}
            onClick={() => void save()}
          >
            Save setting
          </Button>
        </div>
      )}
    </div>
  );
}

function stringify(value: unknown, valueType: string): string {
  if (valueType === 'JSON') return JSON.stringify(value, null, 2);
  return String(value);
}

function parse(draft: string, valueType: string): unknown {
  const trimmed = draft.trim();
  switch (valueType) {
    case 'NUMBER': {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error('Enter a number.');
      return parsed;
    }
    case 'BOOLEAN': {
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
      throw new Error('Enter true or false.');
    }
    case 'JSON':
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error('That is not valid JSON.');
      }
    default:
      return draft;
  }
}
