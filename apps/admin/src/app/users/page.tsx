import type { Metadata } from 'next';
import { Card, PageHeader, TableShell, Td, Th } from '@health/ui';
import type { Paginated } from '@health/types';
import { apiRequestOrSignIn } from '@/lib/guards';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { InviteStaffForm } from '@/components/invite-staff-form';
import { UserRow } from '@/components/user-row';

export const metadata: Metadata = { title: 'Staff & customers' };

export interface UserView {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  type: string;
  status: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; search?: string }>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'USER_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="USER_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '50' });
  if (params.type === 'STAFF' || params.type === 'CUSTOMER') query.set('type', params.type);
  if (params.search) query.set('search', params.search);

  const page = await apiRequestOrSignIn<Paginated<UserView>>(`/api/v1/users?${query.toString()}`);
  const canInvite = hasPermission(user, 'USER_WRITE');
  const canManage = hasPermission(user, 'USER_MANAGE');

  const roles = canManage
    ? await apiRequestOrSignIn<{ data: Array<{ key: string; isSystem: boolean }> }>('/api/v1/roles')
    : { data: [] };

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Staff & customers"
          description="Staff are invited, never created with a password by someone else. Suspending an account or changing its roles signs it out immediately."
        />

        {canInvite ? (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Invite a staff member</h2>
            <p className="mt-1 text-sm text-slate-600">
              They receive a single-use link and choose their own password. If their role requires
              two-factor authentication they will be asked to set it up before they can do anything.
            </p>
            <div className="mt-4">
              <InviteStaffForm
                availableRoles={roles.data.filter((r) => r.key !== 'CUSTOMER').map((r) => r.key)}
              />
            </div>
          </Card>
        ) : null}

        <TableShell caption="Accounts">
          <thead className="bg-slate-50">
            <tr>
              <Th>Account</Th>
              <Th>Type</Th>
              <Th>Roles</Th>
              <Th>Status</Th>
              <Th>Last sign-in</Th>
              {canManage ? <Th>Actions</Th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {page.data.map((row) => (
              <UserRow
                key={row.id}
                user={row}
                canManage={canManage}
                isSelf={row.id === user.id}
                availableRoles={roles.data.filter((r) => r.key !== 'CUSTOMER').map((r) => r.key)}
              />
            ))}
            {page.data.length === 0 ? (
              <tr>
                <Td className="py-8 text-center text-slate-500">No accounts match this filter.</Td>
              </tr>
            ) : null}
          </tbody>
        </TableShell>

        <p className="text-sm text-slate-500">
          Showing {page.meta.count} account{page.meta.count === 1 ? '' : 's'}
          {page.meta.nextCursor ? ' (more available)' : ''}.
        </p>
      </div>
    </ConsoleShell>
  );
}
