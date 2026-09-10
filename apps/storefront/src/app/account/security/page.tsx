import type { Metadata } from 'next';
import { Badge, Card, PageHeader, TableShell, Td, Th } from '@health/ui';
import { apiRequestOrSignIn } from '@/lib/guards';
import { formatDateTime, formatRelative } from '@/lib/format';
import { ChangePasswordForm } from '@/components/change-password-form';
import { MfaPanel } from '@/components/mfa-panel';
import { SignOutEverywhereButton } from '@/components/sign-out-everywhere-button';

export const metadata: Metadata = { title: 'Security', robots: { index: false } };

interface SessionRow {
  id: string;
  current: boolean;
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  mfaSatisfied: boolean;
}

interface MfaStatus {
  enabled: boolean;
  remainingRecoveryCodes: number;
}

export default async function SecurityPage() {
  const [{ data: sessions }, mfa] = await Promise.all([
    apiRequestOrSignIn<{ data: SessionRow[] }>('/api/v1/auth/sessions'),
    apiRequestOrSignIn<MfaStatus>('/api/v1/auth/mfa'),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="Your password, two-factor authentication, and where you are signed in."
      />

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Two-factor authentication</h2>
        <p className="mt-1 max-w-prose text-sm text-slate-600">
          A second factor means a stolen password is not enough to reach your account. We support
          any standard authenticator app.
        </p>
        <div className="mt-4">
          <MfaPanel status={mfa} />
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Change your password</h2>
        <p className="mt-1 text-sm text-slate-600">
          Changing your password signs you out of every other device.
        </p>
        <div className="mt-4 max-w-md">
          <ChangePasswordForm />
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Where you are signed in</h2>
            <p className="mt-1 text-sm text-slate-600">
              Network locations are recorded imprecisely on purpose — enough to spot something
              unusual, not enough to track you.
            </p>
          </div>
          <SignOutEverywhereButton />
        </div>

        <div className="mt-4">
          <TableShell caption="Active sessions">
            <thead className="bg-slate-50">
              <tr>
                <Th>Device</Th>
                <Th>Network</Th>
                <Th>Started</Th>
                <Th>Last used</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sessions.map((session) => (
                <tr key={session.id}>
                  <Td>
                    <span
                      className="block max-w-xs truncate"
                      title={session.userAgent ?? undefined}
                    >
                      {describeDevice(session.userAgent)}
                    </span>
                    <span className="mt-1 flex gap-1">
                      {session.current ? <Badge tone="success">This device</Badge> : null}
                      {session.mfaSatisfied ? <Badge tone="info">2FA verified</Badge> : null}
                    </span>
                  </Td>
                  <Td className="font-mono text-xs">{session.ipAddress ?? '—'}</Td>
                  <Td>
                    <time dateTime={session.issuedAt}>{formatDateTime(session.issuedAt)}</time>
                  </Td>
                  <Td>{session.lastUsedAt ? formatRelative(session.lastUsedAt) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>
      </Card>
    </div>
  );
}

/** A short, honest summary — user-agent parsing beyond this is guesswork. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  if (/iPhone|iPad/i.test(userAgent)) return 'iOS device';
  if (/Android/i.test(userAgent)) return 'Android device';
  if (/Macintosh/i.test(userAgent)) return 'Mac';
  if (/Windows/i.test(userAgent)) return 'Windows PC';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return 'Browser';
}
