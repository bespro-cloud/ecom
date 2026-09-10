'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';

export function ChangePasswordForm() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setDone(false);

    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get('newPassword') ?? '');

    if (newPassword !== String(data.get('confirmPassword') ?? '')) {
      setFieldErrors({ confirmPassword: 'The two passwords do not match.' });
      return;
    }

    setSubmitting(true);
    try {
      await clientRequest('/api/v1/auth/password/change', {
        method: 'POST',
        body: { currentPassword: String(data.get('currentPassword') ?? ''), newPassword },
      });
      setDone(true);
      form.reset();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        if (Object.keys(caught.fieldErrors).length === 0) setError(caught.message);
      } else {
        setError('We could not change your password. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {done ? (
        <Alert tone="success">
          Your password has been changed and other devices have been signed out.
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        error={fieldErrors.currentPassword}
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        hint="At least 12 characters, and not one you have used here before."
        error={fieldErrors.newPassword}
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={fieldErrors.confirmPassword}
      />

      <Button type="submit" loading={submitting} loadingLabel="Saving…">
        Change password
      </Button>
    </form>
  );
}
