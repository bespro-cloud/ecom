import type { Metadata } from 'next';
import { Alert, Card } from '@health/ui';
import { AcceptInviteForm } from '@/components/accept-invite-form';

export const metadata: Metadata = { title: 'Accept your invitation' };

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <Card>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Set up your admin account
        </h1>
        {token ? (
          <>
            <p className="mt-2 text-sm text-slate-600">
              Choose a password. Nobody else knows it — not even the administrator who invited you.
            </p>
            <div className="mt-6">
              <AcceptInviteForm token={token} />
            </div>
          </>
        ) : (
          <div className="mt-6">
            <Alert tone="error" title="This link is not valid">
              The invitation link is missing its token. Ask an administrator to send a new one.
            </Alert>
          </div>
        )}
      </Card>
    </div>
  );
}
