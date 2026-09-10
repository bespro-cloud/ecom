'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field } from '@health/ui';
import { registerSchema } from '@health/validation';
import { clientRequest, ClientApiError } from '@/lib/client';

/**
 * Registration form.
 *
 * The same Zod schema the API enforces runs here first, so the common mistakes
 * are caught without a round trip. The client-side pass is a convenience only —
 * the API re-validates everything and is the sole authority.
 */
export function RegisterForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const data = new FormData(event.currentTarget);
    const candidate = {
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
      firstName: String(data.get('firstName') ?? ''),
      lastName: String(data.get('lastName') ?? ''),
      acceptsTerms: data.get('acceptsTerms') === 'on',
      acceptsMarketingEmail: data.get('acceptsMarketingEmail') === 'on',
    };

    const parsed = registerSchema.safeParse(candidate);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        if (!errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      await clientRequest('/api/v1/auth/register', { method: 'POST', body: parsed.data });
      router.replace('/account');
      router.refresh();
    } catch (error) {
      if (error instanceof ClientApiError) {
        setFieldErrors(error.fieldErrors);
        // Only show a form-level message when nothing landed on a field, so the
        // user is not told the same thing twice.
        if (Object.keys(error.fieldErrors).length === 0) setFormError(error.message);
      } else {
        setFormError('We could not complete registration. Please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {formError ? <Alert tone="error">{formError}</Alert> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="First name"
          name="firstName"
          autoComplete="given-name"
          required
          error={fieldErrors.firstName}
        />
        <Field
          label="Last name"
          name="lastName"
          autoComplete="family-name"
          required
          error={fieldErrors.lastName}
        />
      </div>

      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldErrors.email}
      />

      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint="At least 12 characters. A short phrase you will remember beats a short, complicated word."
        error={fieldErrors.password}
      />

      <Checkbox
        name="acceptsTerms"
        required
        label="I agree to the terms of service and the privacy policy."
        error={fieldErrors.acceptsTerms}
      />

      <Checkbox
        name="acceptsMarketingEmail"
        label="Send me occasional product news by email."
        hint="Optional, and you can turn it off at any time from your account."
      />

      <Button
        type="submit"
        size="lg"
        loading={submitting}
        loadingLabel="Creating your account…"
        className="w-full"
      >
        Create account
      </Button>
    </form>
  );
}
