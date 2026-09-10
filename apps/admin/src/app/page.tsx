import type { Metadata } from 'next';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const user = await currentUser();
  // Middleware has already redirected anyone without a session; this handles
  // the narrow race where it expired in between.
  if (!user) return null;

  const mfaRequired = user.roles.some((role) =>
    ['SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_REVIEWER'].includes(role),
  );

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={`Welcome, ${user.firstName ?? user.email}`}
          description="Phase 1 of the platform: identity, roles, auditing and configuration. Catalogue and commerce arrive in later phases."
        />

        {mfaRequired && !user.mfaEnabled ? (
          <Alert tone="error" title="Two-factor authentication is required for your role">
            Your role can change things that matter. Until you enrol a second factor, this console
            will refuse every action except enrolment itself, and sign-in stops working once the
            enrolment window closes.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <h2 className="text-sm font-medium text-slate-500">Your roles</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {user.roles.length > 0 ? (
                user.roles.map((role) => (
                  <Badge key={role} tone="info">
                    {role}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-slate-500">None assigned</span>
              )}
            </div>
          </Card>

          <Card>
            <h2 className="text-sm font-medium text-slate-500">Effective permissions</h2>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{user.permissions.length}</p>
            <p className="mt-1 text-sm text-slate-500">Derived from your roles at sign-in.</p>
          </Card>

          <Card>
            <h2 className="text-sm font-medium text-slate-500">Two-factor authentication</h2>
            <div className="mt-2">
              <Badge tone={user.mfaEnabled ? 'success' : 'danger'}>
                {user.mfaEnabled ? 'Enrolled' : 'Not enrolled'}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              {user.mfaEnabled
                ? 'Required for privileged actions and satisfied for this session.'
                : 'Enrol from the storefront account security page.'}
            </p>
          </Card>
        </div>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">What this console enforces</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-600">
            <li>
              <strong className="text-slate-900">Roles grant permissions, never people.</strong>{' '}
              Individual permissions cannot be assigned to a user; changing what someone can do
              means changing their roles, and that change is recorded with a written reason.
            </li>
            <li>
              <strong className="text-slate-900">Compliance approval is separated.</strong> An
              administrator cannot approve a product claim. Only the compliance reviewer role can,
              and only with two-factor authentication satisfied.
            </li>
            <li>
              <strong className="text-slate-900">The audit log is append-only.</strong> The database
              itself refuses updates and deletes on it — not just the application.
            </li>
            <li>
              <strong className="text-slate-900">Privilege changes take effect at once.</strong>{' '}
              Altering roles or suspending an account revokes that user’s sessions immediately.
            </li>
          </ul>
        </Card>
      </div>
    </ConsoleShell>
  );
}
