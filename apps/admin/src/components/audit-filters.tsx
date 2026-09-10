'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Card, Field, SelectField } from '@health/ui';

const COMMON_ACTIONS = [
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.token.reuse_detected',
  'mfa.enrolled',
  'mfa.challenge.failed',
  'user.roles.changed',
  'user.invited',
  'user.status.changed',
  'role.updated',
  'system.setting.updated',
  'system.feature_flag.updated',
];

export function AuditFilters({
  current,
}: {
  current: { action: string; outcome: string; entityType: string };
}) {
  const router = useRouter();
  const [values, setValues] = useState(current);

  function apply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const query = new URLSearchParams();
    if (values.action) query.set('action', values.action);
    if (values.outcome) query.set('outcome', values.outcome);
    if (values.entityType) query.set('entityType', values.entityType);
    router.push(query.size > 0 ? `/audit?${query.toString()}` : '/audit');
  }

  return (
    <Card>
      <form onSubmit={apply} className="grid gap-4 sm:grid-cols-4 sm:items-end">
        <SelectField
          label="Action"
          value={values.action}
          onChange={(event) => setValues((v) => ({ ...v, action: event.target.value }))}
        >
          <option value="">All actions</option>
          {COMMON_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </SelectField>

        <SelectField
          label="Outcome"
          value={values.outcome}
          onChange={(event) => setValues((v) => ({ ...v, outcome: event.target.value }))}
        >
          <option value="">Any outcome</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILURE">Failure</option>
        </SelectField>

        <Field
          label="Entity type"
          placeholder="user, role, system_setting…"
          value={values.entityType}
          onChange={(event) => setValues((v) => ({ ...v, entityType: event.target.value }))}
        />

        <div className="flex gap-2">
          <Button type="submit">Apply</Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setValues({ action: '', outcome: '', entityType: '' });
              router.push('/audit');
            }}
          >
            Clear
          </Button>
        </div>
      </form>
    </Card>
  );
}
