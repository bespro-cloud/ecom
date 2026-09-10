'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';

export function InviteStaffForm({ availableRoles }: { availableRoles: string[] }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSentTo(null);

    if (roles.length === 0) {
      setFieldErrors({ roleKeys: 'Choose at least one role.' });
      return;
    }

    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    try {
      await clientRequest('/api/v1/users/invite', {
        method: 'POST',
        body: {
          email: String(data.get('email') ?? ''),
          firstName: String(data.get('firstName') ?? ''),
          lastName: String(data.get('lastName') ?? ''),
          roleKeys: roles,
        },
      });
      setSentTo(String(data.get('email') ?? ''));
      form.reset();
      setRoles([]);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        if (Object.keys(caught.fieldErrors).length === 0) setError(caught.message);
      } else {
        setError('Could not send the invitation.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {sentTo ? <Alert tone="success">Invitation sent to {sentTo}.</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="First name" name="firstName" required error={fieldErrors.firstName} />
        <Field label="Last name" name="lastName" required error={fieldErrors.lastName} />
        <Field label="Email address" name="email" type="email" required error={fieldErrors.email} />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-900">Roles</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {availableRoles.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                checked={roles.includes(role)}
                onChange={(event) =>
                  setRoles((current) =>
                    event.target.checked
                      ? [...current, role]
                      : current.filter((value) => value !== role),
                  )
                }
              />
              {role}
            </label>
          ))}
        </div>
        {fieldErrors.roleKeys ? (
          <p role="alert" className="mt-2 text-sm font-medium text-red-700">
            {fieldErrors.roleKeys}
          </p>
        ) : null}
      </fieldset>

      <Button type="submit" loading={submitting} loadingLabel="Sending…">
        Send invitation
      </Button>
    </form>
  );
}
