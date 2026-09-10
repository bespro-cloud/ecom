import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert, Card } from '@health/ui';
import { currentUser } from '@/lib/session';
import { AdminSignInForm } from '@/components/admin-sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  if (await currentUser()) redirect('/');
  const params = await searchParams;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="mb-8 text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white">
          HC
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-slate-900">
          Health Commerce Admin
        </h1>
      </div>

      <Card>
        {params.reason === 'session-expired' ? (
          <div className="mb-4">
            <Alert tone="warning">Your session has expired. Please sign in again.</Alert>
          </div>
        ) : null}
        <AdminSignInForm nextPath={safeNext(params.next)} />
      </Card>

      <p className="mt-6 text-center text-xs text-slate-500">
        Access is logged. Privileged roles require two-factor authentication.
      </p>
    </div>
  );
}

/** Same-origin absolute paths only — never an open redirect. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}
