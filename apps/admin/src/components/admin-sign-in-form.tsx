'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '@health/ui';
import type { PublicUser } from '@health/types';
import { clientRequest, ClientApiError } from '@/lib/client';

type LoginResponse =
  | { user: PublicUser; accessToken: string }
  | { status: 'MFA_REQUIRED'; challengeToken: string; expiresAt: string; methods: string[] };

/**
 * Admin sign-in.
 *
 * Every staff role that can change anything consequential requires a second
 * factor, so the challenge step is the normal path here rather than the
 * exception.
 */
export function AdminSignInForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<{ token: string; methods: string[] } | null>(null);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  function complete(): void {
    router.replace(nextPath);
    router.refresh();
  }

  async function onPassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const data = new FormData(event.currentTarget);
    try {
      const result = await clientRequest<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email: String(data.get('email') ?? ''),
          password: String(data.get('password') ?? ''),
        },
      });

      if ('status' in result && result.status === 'MFA_REQUIRED') {
        setChallenge({ token: result.challengeToken, methods: result.methods });
        setSubmitting(false);
        return;
      }
      complete();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'We could not sign you in.');
      setSubmitting(false);
    }
  }

  async function onCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!challenge) return;
    setError(null);
    setSubmitting(true);

    const value = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    try {
      await clientRequest('/api/v1/auth/mfa/verify', {
        method: 'POST',
        body: {
          challengeToken: challenge.token,
          ...(useRecoveryCode ? { recoveryCode: value } : { code: value }),
        },
      });
      complete();
    } catch (caught) {
      setError(
        caught instanceof ClientApiError ? caught.message : 'We could not verify that code.',
      );
      setSubmitting(false);
      if (caught instanceof ClientApiError && /already been used|expired/i.test(caught.message)) {
        setChallenge(null);
      }
    }
  }

  if (challenge) {
    return (
      <form onSubmit={onCode} noValidate className="space-y-5">
        <h2 className="text-lg font-semibold text-slate-900">Two-factor verification</h2>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field
          key={useRecoveryCode ? 'recovery' : 'totp'}
          label={useRecoveryCode ? 'Recovery code' : 'Authentication code'}
          name="code"
          inputMode={useRecoveryCode ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          required
          autoFocus
          placeholder={useRecoveryCode ? 'XXXXX-XXXXX' : '123456'}
        />
        <Button
          type="submit"
          size="lg"
          loading={submitting}
          loadingLabel="Verifying…"
          className="w-full"
        >
          Verify
        </Button>
        {challenge.methods.includes('RECOVERY_CODE') ? (
          <button
            type="button"
            onClick={() => {
              setUseRecoveryCode((current) => !current);
              setError(null);
            }}
            className="w-full text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            {useRecoveryCode ? 'Use your authenticator app' : 'Use a recovery code'}
          </button>
        ) : null}
      </form>
    );
  }

  return (
    <form onSubmit={onPassword} noValidate className="space-y-5">
      <h2 className="text-lg font-semibold text-slate-900">Sign in</h2>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        required
        autoFocus
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <Button
        type="submit"
        size="lg"
        loading={submitting}
        loadingLabel="Signing in…"
        className="w-full"
      >
        Sign in
      </Button>
    </form>
  );
}
