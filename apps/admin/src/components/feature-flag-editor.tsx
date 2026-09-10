'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';
import type { FeatureFlag } from '@/app/settings/page';

export function FeatureFlagEditor({ flag }: { flag: FeatureFlag }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(flag.enabled);
  const [rollout, setRollout] = useState(flag.rolloutPercentage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = enabled !== flag.enabled || rollout !== flag.rolloutPercentage;

  async function save(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await clientRequest(`/api/v1/system/feature-flags/${encodeURIComponent(flag.key)}`, {
        method: 'PUT',
        body: {
          enabled,
          rolloutPercentage: rollout,
          enabledForSubjects: flag.enabledForSubjects,
          ...(flag.description ? { description: flag.description } : {}),
        },
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'Could not save the flag.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-medium text-slate-900">{flag.key}</p>
          {flag.description ? (
            <p className="mt-0.5 max-w-2xl text-sm text-slate-600">{flag.description}</p>
          ) : null}
        </div>
        <Badge tone={flag.enabled ? 'success' : 'neutral'}>{flag.enabled ? 'On' : 'Off'}</Badge>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
          />
          Enabled
        </label>

        <label className="text-sm">
          <span className="block font-medium text-slate-900">Rollout ({rollout}%)</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={rollout}
            onChange={(event) => setRollout(Number(event.target.value))}
            disabled={!enabled}
            className="mt-1 w-48 accent-brand-600 disabled:opacity-50"
          />
        </label>

        {flag.enabledForSubjects.length > 0 ? (
          <p className="text-xs text-slate-500">
            {flag.enabledForSubjects.length} subject
            {flag.enabledForSubjects.length === 1 ? '' : 's'} always on
          </p>
        ) : null}

        <Button
          size="sm"
          loading={busy}
          loadingLabel="Saving…"
          disabled={!dirty}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
