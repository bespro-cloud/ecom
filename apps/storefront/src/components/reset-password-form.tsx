'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    const confirmation = String(data.get('confirmPassword') ?? '');

    if (password !== confirmation) {
      setFieldErrors({ confirmPassword: 'The two passwords do not match.' });
      return;
    }

    setSubmitting(true);
    try {
      await clientRequest('/api/v1/auth/password/reset', {
        method: 'POST',
        body: { token, password },
      });
      setDone(true);
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        if (caught.status === 401) {
          setExpired(true);
        } else {
          setFieldErrors(caught.fieldErrors);
          if (Object.keys(caught.fieldErrors).length === 0) setError(caught.message);
        }
      } else {
        setError('We could not reset your password. Please try again.');
      }
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Your password has been changed">
          Every signed-in session was ended. Sign in again with your new password.
        </Alert>
        <Button size="lg" className="w-full" onClick={() => router.replace('/login')}>
          Go to sign in
        </Button>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="space-y-4">
        <Alert tone="error" title="This link is no longer valid">
          Reset links expire after an hour and can only be used once.
        </Alert>
        <Link href="/forgot-password">
          <Button size="lg" variant="secondary" className="w-full">
            Request a new link
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        autoFocus
        hint="At least 12 characters."
        error={fieldErrors.password}
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={fieldErrors.confirmPassword}
      />
      <Button
        type="submit"
        size="lg"
        loading={submitting}
        loadingLabel="Saving…"
        className="w-full"
      >
        Set new password
      </Button>
    </form>
  );
}
