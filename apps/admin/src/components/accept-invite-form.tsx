'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';

export function AcceptInviteForm({ token }: { token: string }) {
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
    if (password !== String(data.get('confirmPassword') ?? '')) {
      setFieldErrors({ confirmPassword: 'The two passwords do not match.' });
      return;
    }

    setSubmitting(true);
    try {
      await clientRequest('/api/v1/users/invite/accept', {
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
        setError('We could not set up your account. Please try again.');
      }
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Your account is ready">
          Sign in with your new password. If your role requires two-factor authentication you will
          be prompted to set it up before you can do anything else.
        </Alert>
        <Button className="w-full" onClick={() => router.replace('/sign-in')}>
          Go to sign in
        </Button>
      </div>
    );
  }

  if (expired) {
    return (
      <Alert tone="error" title="This invitation is no longer valid">
        Invitations expire after seven days and can be used once. Ask an administrator to send a new
        one.
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        autoFocus
        hint="At least 12 characters. A short phrase works better than a short, complicated word."
        error={fieldErrors.password}
      />
      <Field
        label="Confirm password"
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
        loadingLabel="Setting up…"
        className="w-full"
      >
        Set password
      </Button>
    </form>
  );
}
