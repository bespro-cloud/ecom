'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Td } from '@health/ui';
import { clientRequest, ClientApiError } from '@/lib/client';
import { formatRelative } from '@/lib/format';
import type { UserView } from '@/app/users/page';

const STATUS_TONE = {
  ACTIVE: 'success',
  INVITED: 'info',
  SUSPENDED: 'warning',
  DEACTIVATED: 'danger',
} as const;

export function UserRow({
  user,
  canManage,
  isSelf,
  availableRoles,
}: {
  user: UserView;
  canManage: boolean;
  isSelf: boolean;
  availableRoles: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(user.roles);
  const [reason, setReason] = useState('');

  async function saveRoles(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await clientRequest(`/api/v1/users/${user.id}/roles`, {
        method: 'PUT',
        body: { roleKeys: selected, reason },
      });
      setEditing(false);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'Could not save the change.');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await clientRequest(`/api/v1/users/${user.id}`, { method: 'PATCH', body: { status } });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'Could not update the account.');
    } finally {
      setBusy(false);
    }
  }

  const tone = STATUS_TONE[user.status as keyof typeof STATUS_TONE] ?? 'neutral';

  return (
    <>
      <tr>
        <Td>
          <span className="block font-medium text-slate-900">
            {[user.firstName, user.lastName].filter(Boolean).join(' ') || '—'}
          </span>
          <span className="block text-xs text-slate-500">{user.email}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {!user.emailVerified ? <Badge tone="warning">Email unconfirmed</Badge> : null}
            {user.type === 'STAFF' && !user.mfaEnabled ? <Badge tone="danger">No 2FA</Badge> : null}
          </span>
        </Td>
        <Td>{user.type === 'STAFF' ? 'Staff' : 'Customer'}</Td>
        <Td>
          <span className="flex flex-wrap gap-1">
            {user.roles.length > 0 ? (
              user.roles.map((role) => <Badge key={role}>{role}</Badge>)
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </span>
        </Td>
        <Td>
          <Badge tone={tone}>{user.status}</Badge>
        </Td>
        <Td>{user.lastLoginAt ? formatRelative(user.lastLoginAt) : 'Never'}</Td>
        {canManage ? (
          <Td>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={isSelf}
                onClick={() => setEditing((current) => !current)}
              >
                {editing ? 'Cancel' : 'Roles'}
              </Button>
              {user.status === 'ACTIVE' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isSelf}
                  loading={busy}
                  onClick={() => void setStatus('SUSPENDED')}
                >
                  Suspend
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isSelf || user.status === 'INVITED'}
                  loading={busy}
                  onClick={() => void setStatus('ACTIVE')}
                >
                  Reinstate
                </Button>
              )}
            </div>
            {isSelf ? (
              <p className="mt-1 text-xs text-slate-500">
                You cannot change your own roles or status.
              </p>
            ) : null}
          </Td>
        ) : null}
      </tr>

      {editing ? (
        <tr className="bg-slate-50">
          <td colSpan={canManage ? 6 : 5} className="px-4 py-4">
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-slate-900">Roles for {user.email}</legend>
              {error ? (
                <p role="alert" className="text-sm font-medium text-red-700">
                  {error}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-3">
                {availableRoles.map((role) => (
                  <label key={role} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                      checked={selected.includes(role)}
                      onChange={(event) =>
                        setSelected((current) =>
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

              <label className="block text-sm">
                <span className="font-medium text-slate-900">
                  Why is this changing?
                  <span className="sr-only"> (required)</span>
                </span>
                <input
                  type="text"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  minLength={5}
                  placeholder="Joined the fulfilment team"
                  className="mt-1 block w-full max-w-lg rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-brand-600"
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Stored in the audit log. Changing roles signs this user out everywhere.
                </span>
              </label>

              <Button
                size="sm"
                loading={busy}
                loadingLabel="Saving…"
                disabled={reason.trim().length < 5}
                onClick={() => void saveRoles()}
              >
                Save roles
              </Button>
            </fieldset>
          </td>
        </tr>
      ) : null}
    </>
  );
}
