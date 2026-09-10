'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Field } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';

interface MfaStatus {
  enabled: boolean;
  remainingRecoveryCodes: number;
}

interface Enrollment {
  factorId: string;
  uri: string;
  secret: string;
}

/**
 * Two-factor enrolment.
 *
 * The shared secret and the recovery codes are shown exactly once and are never
 * retrievable again — there is no endpoint that returns them. The UI says so
 * plainly, because a user who skips past this screen is locked out later.
 */
export function MfaPanel({ status }: { status: MfaStatus }) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      setEnrollment(await clientRequest<Enrollment>('/api/v1/auth/mfa/enroll', { method: 'POST' }));
    } catch (caught) {
      setError(
        caught instanceof ClientApiError ? caught.message : 'We could not start setup. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!enrollment) return;
    setError(null);
    setBusy(true);

    const code = String(new FormData(event.currentTarget).get('code') ?? '');
    try {
      const result = await clientRequest<{ recoveryCodes: string[] }>(
        '/api/v1/auth/mfa/enroll/confirm',
        { method: 'POST', body: { factorId: enrollment.factorId, code } },
      );
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError
          ? caught.message
          : 'We could not verify that code. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Two-factor authentication is on">
          Save these recovery codes somewhere safe. Each one works once, and they are the only way
          back into your account if you lose your authenticator app.{' '}
          <strong>They will not be shown again.</strong>
        </Alert>
        <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-4 font-mono text-sm ring-1 ring-slate-200 sm:grid-cols-3">
          {recoveryCodes.map((code) => (
            <li key={code} className="tabular-nums">
              {code}
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(recoveryCodes.join('\n'));
          }}
        >
          Copy codes
        </Button>
      </div>
    );
  }

  if (enrollment) {
    return (
      <form onSubmit={confirm} noValidate className="space-y-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Alert tone="info" title="Add this account to your authenticator app">
          Scan the code below, or enter the key by hand. Then type the six-digit code your app shows
          to finish.
        </Alert>

        <div className="rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Setup key</p>
          <p className="mt-1 break-all font-mono text-sm text-slate-900">{enrollment.secret}</p>
          <p className="mt-3 text-xs text-slate-500">
            Most apps can also open this link directly on a mobile device.
          </p>
          <a
            href={enrollment.uri}
            className="mt-1 inline-block break-all font-mono text-xs text-brand-700 hover:text-brand-800"
          >
            {enrollment.uri.slice(0, 64)}…
          </a>
        </div>

        <Field
          label="Code from your app"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          required
          autoFocus
        />

        <div className="flex gap-3">
          <Button type="submit" loading={busy} loadingLabel="Verifying…">
            Turn on two-factor authentication
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEnrollment(null)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={status.enabled ? 'success' : 'neutral'}>{status.enabled ? 'On' : 'Off'}</Badge>
        {status.enabled ? (
          <span className="text-sm text-slate-600">
            {status.remainingRecoveryCodes} recovery code
            {status.remainingRecoveryCodes === 1 ? '' : 's'} remaining
          </span>
        ) : null}
      </div>

      {status.enabled && status.remainingRecoveryCodes <= 2 ? (
        <Alert tone="warning" title="You are low on recovery codes">
          Generate a new set so you do not get locked out. The old codes stop working immediately.
        </Alert>
      ) : null}

      {status.enabled ? (
        <Button
          variant="secondary"
          loading={busy}
          loadingLabel="Generating…"
          onClick={() => {
            setBusy(true);
            setError(null);
            clientRequest<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/recovery-codes', {
              method: 'POST',
            })
              .then((result) => setRecoveryCodes(result.recoveryCodes))
              .catch(() => setError('We could not generate new codes. Please try again.'))
              .finally(() => setBusy(false));
          }}
        >
          Generate new recovery codes
        </Button>
      ) : (
        <Button loading={busy} loadingLabel="Preparing…" onClick={() => void start()}>
          Set up two-factor authentication
        </Button>
      )}
    </div>
  );
}
