import type { Metadata } from 'next';
import { Badge, Card, PageHeader } from '@health/ui';
import { apiRequestOrSignIn } from '@/lib/guards';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Roles & permissions' };

interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  requiresMfa: boolean;
  permissions: string[];
  userCount: number;
}

export default async function RolesPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'ROLE_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="ROLE_READ" />
      </ConsoleShell>
    );
  }

  const [{ data: roles }, { data: catalogue }] = await Promise.all([
    apiRequestOrSignIn<{ data: RoleView[] }>('/api/v1/roles'),
    apiRequestOrSignIn<{
      data: Array<{ key: string; resource: string; action: string; description: string }>;
    }>('/api/v1/roles/permissions'),
  ]);

  const byResource = new Map<string, typeof catalogue>();
  for (const permission of catalogue) {
    const bucket = byResource.get(permission.resource) ?? [];
    bucket.push(permission);
    byResource.set(permission.resource, bucket);
  }

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Roles & permissions"
          description="System roles are defined in code and synced on deploy — they cannot be edited here, so a compromised session cannot quietly widen them."
        />

        <div className="grid gap-4 lg:grid-cols-2">
          {roles.map((role) => (
            <Card key={role.id} as="article">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">{role.name}</h2>
                  <p className="font-mono text-xs text-slate-500">{role.key}</p>
                </div>
                <div className="flex gap-1.5">
                  {role.isSystem ? <Badge>System</Badge> : <Badge tone="info">Custom</Badge>}
                  {role.requiresMfa ? <Badge tone="warning">2FA required</Badge> : null}
                </div>
              </div>

              {role.description ? (
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{role.description}</p>
              ) : null}

              <p className="mt-3 text-sm text-slate-500">
                {role.userCount} user{role.userCount === 1 ? '' : 's'} · {role.permissions.length}{' '}
                permission{role.permissions.length === 1 ? '' : 's'}
              </p>

              {role.permissions.length > 0 ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-brand-700 hover:text-brand-800">
                    Show permissions
                  </summary>
                  <ul className="mt-2 flex flex-wrap gap-1">
                    {role.permissions.map((permission) => (
                      <li key={permission}>
                        <Badge className="font-mono">{permission}</Badge>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </Card>
          ))}
        </div>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Permission catalogue</h2>
          <p className="mt-1 text-sm text-slate-600">
            Every permission the platform recognises, grouped by the resource it governs.
            Authorisation checks only ever test a permission — never a role name.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...byResource.entries()].map(([resource, permissions]) => (
              <div key={resource}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {resource}
                </h3>
                <ul className="mt-1.5 space-y-1">
                  {permissions.map((permission) => (
                    <li key={permission.key} className="text-sm">
                      <span className="font-mono text-xs text-slate-900">{permission.key}</span>
                      <span className="block text-xs text-slate-500">{permission.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </ConsoleShell>
  );
}
