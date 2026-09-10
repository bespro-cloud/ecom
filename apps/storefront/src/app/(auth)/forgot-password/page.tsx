import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@health/ui';
import { ForgotPasswordForm } from '@/components/forgot-password-form';

export const metadata: Metadata = {
  title: 'Reset your password',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Reset your password</h1>
      <p className="mt-2 text-sm text-slate-600">
        Enter your email address and we will send you a link to choose a new password.
      </p>
      <div className="mt-6">
        <ForgotPasswordForm />
      </div>
      <p className="mt-6 text-sm text-slate-600">
        <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
          Back to sign in
        </Link>
      </p>
    </Card>
  );
}
