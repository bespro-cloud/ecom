import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card } from '@health/ui';
import { currentUser } from '@/lib/session';
import { LoginForm } from '@/components/login-form';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  if (await currentUser()) redirect('/account');
  const params = await searchParams;

  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
      <div className="mt-6">
        <LoginForm
          nextPath={safeNext(params.next)}
          reason={params.reason === 'session-expired' ? 'session-expired' : undefined}
        />
      </div>
      <div className="mt-6 space-y-2 text-sm text-slate-600">
        <p>
          <Link href="/forgot-password" className="font-medium text-brand-700 hover:text-brand-800">
            Forgotten your password?
          </Link>
        </p>
        <p>
          No account yet?{' '}
          <Link href="/register" className="font-medium text-brand-700 hover:text-brand-800">
            Create one
          </Link>
        </p>
      </div>
    </Card>
  );
}

/**
 * Only same-origin, absolute-path redirects are honoured. Accepting an
 * arbitrary `next` would turn the sign-in page into an open redirect that a
 * phishing link could point anywhere.
 */
function safeNext(next: string | undefined): string {
  if (!next) return '/account';
  if (!next.startsWith('/') || next.startsWith('//')) return '/account';
  return next;
}
