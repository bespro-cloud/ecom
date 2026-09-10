'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '@health/ui';
import { clientRequest } from '@/lib/client';

export function ForgotPasswordForm() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    try {
      await clientRequest('/api/v1/auth/password/forgot', { method: 'POST', body: { email } });
      setSent(true);
    } catch {
      // Deliberately generic. Distinguishing outcomes here would turn the form
      // into a way of discovering which addresses are registered.
      setError('We could not process that request. Please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Alert tone="success" title="Check your inbox">
        If an account exists for that address, a password reset link is on its way. The link is
        valid for one hour and can be used once.
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        required
        autoFocus
      />
      <Button
        type="submit"
        size="lg"
        loading={submitting}
        loadingLabel="Sending…"
        className="w-full"
      >
        Send reset link
      </Button>
    </form>
  );
}
