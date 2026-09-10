import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card } from '@health/ui';
import { apiRequest, ApiError } from '@/lib/api-client';

export const metadata: Metadata = {
  title: 'Confirm your email address',
  robots: { index: false, follow: false },
};

/**
 * Verification happens on the server as the page renders, so the link works
 * from any email client without JavaScript.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Confirm your email address
        </h1>
        <div className="mt-6">
          <Alert tone="error" title="This link is not valid">
            The confirmation link is missing its token. It may have been truncated by your email
            client — try copying the whole address from the message.
          </Alert>
        </div>
      </Card>
    );
  }

  let outcome: 'verified' | 'invalid' | 'error';
  try {
    await apiRequest('/api/v1/auth/email/verify', { method: 'POST', body: { token } });
    outcome = 'verified';
  } catch (error) {
    outcome = error instanceof ApiError && error.status === 401 ? 'invalid' : 'error';
  }

  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        Confirm your email address
      </h1>
      <div className="mt-6 space-y-4">
        {outcome === 'verified' ? (
          <Alert tone="success" title="Your email address is confirmed">
            Thank you — nothing else is needed.
          </Alert>
        ) : null}
        {outcome === 'invalid' ? (
          <Alert tone="warning" title="This link is no longer valid">
            Confirmation links expire after three days and can be used once. If your address is
            still unconfirmed, you can send a new link from your account settings.
          </Alert>
        ) : null}
        {outcome === 'error' ? (
          <Alert tone="error" title="We could not confirm your address">
            Something went wrong on our side. Please try the link again shortly.
          </Alert>
        ) : null}

        <p className="text-sm text-slate-600">
          <Link href="/account" className="font-medium text-brand-700 hover:text-brand-800">
            Go to your account
          </Link>
        </p>
      </div>
    </Card>
  );
}
