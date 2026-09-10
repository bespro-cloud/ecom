import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card } from '@health/ui';
import { currentUser } from '@/lib/session';
import { RegisterForm } from '@/components/register-form';

export const metadata: Metadata = {
  title: 'Create an account',
  robots: { index: false, follow: false },
};

export default async function RegisterPage() {
  // Already signed in — nothing useful to do here.
  if (await currentUser()) redirect('/account');

  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Create your account</h1>
      <p className="mt-2 text-sm text-slate-600">
        You will need an account to place an order and to see your order history.
      </p>
      <div className="mt-6">
        <RegisterForm />
      </div>
      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
