import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card } from '@health/ui';
import { ResetPasswordForm } from '@/components/reset-password-form';

export const metadata: Metadata = {
  title: 'Choose a new password',
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        Choose a new password
      </h1>
      {token ? (
        <>
          <p className="mt-2 text-sm text-slate-600">
            Setting a new password signs you out everywhere else.
          </p>
          <div className="mt-6">
            <ResetPasswordForm token={token} />
          </div>
        </>
      ) : (
        <div className="mt-6 space-y-4">
          <Alert tone="error" title="This link is not valid">
            The reset link is missing its token. It may have been truncated by your email client.
          </Alert>
          <p className="text-sm text-slate-600">
            <Link
              href="/forgot-password"
              className="font-medium text-brand-700 hover:text-brand-800"
            >
              Request a new link
            </Link>
          </p>
        </div>
      )}
    </Card>
  );
}
