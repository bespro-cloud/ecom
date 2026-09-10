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
 * Sign-in, including the second factor.
 *
 * The password step never yields a session on its own: when the account has a
 * second factor the API returns a single-use challenge and the form switches to
 * the code step. Nothing about the account is revealed before that point.
 */
export function LoginForm({ nextPath, reason }: { nextPath: string; reason?: 'session-expired' }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    reason === 'session-expired' ? 'Your session has expired. Please sign in again.' : null,
  );
  const [challenge, setChallenge] = useState<{ token: string; methods: string[] } | null>(null);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  function complete(): void {
    router.replace(nextPath);
    router.refresh();
  }

  async function onPasswordSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
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
      setError(
        caught instanceof ClientApiError
          ? caught.message
          : 'We could not sign you in. Please try again.',
      );
      setSubmitting(false);
    }
  }

  async function onCodeSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!challenge) return;
    setError(null);
    setSubmitting(true);

    const data = new FormData(event.currentTarget);
    const value = String(data.get('code') ?? '').trim();

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
      const message =
        caught instanceof ClientApiError
          ? caught.message
          : 'We could not verify that code. Please try again.';
      setError(message);
      setSubmitting(false);

      // A spent or expired challenge cannot be retried; send the user back to
      // the start rather than letting them retype into a dead form.
      if (caught instanceof ClientApiError && /already been used|expired/i.test(caught.message)) {
        setChallenge(null);
      }
    }
  }

  if (challenge) {
    return (
      <form onSubmit={onCodeSubmit} noValidate className="space-y-5">
        <Alert tone="info" title="One more step">
          Enter the current code from your authenticator app to finish signing in.
        </Alert>
        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field
          key={useRecoveryCode ? 'recovery' : 'totp'}
          label={useRecoveryCode ? 'Recovery code' : 'Authentication code'}
          name="code"
          inputMode={useRecoveryCode ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoFocus
          required
          placeholder={useRecoveryCode ? 'XXXXX-XXXXX' : '123456'}
          hint={
            useRecoveryCode
              ? 'One of the single-use codes you saved when you set up two-factor authentication.'
              : 'Six digits, refreshed every 30 seconds.'
          }
        />

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          loadingLabel="Verifying…"
          className="w-full"
        >
          Verify and sign in
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
            {useRecoveryCode ? 'Use your authenticator app instead' : 'Use a recovery code instead'}
          </button>
        ) : null}
      </form>
    );
  }

  return (
    <form onSubmit={onPasswordSubmit} noValidate className="space-y-5">
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
