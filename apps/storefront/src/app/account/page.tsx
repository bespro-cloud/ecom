import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { apiRequestOrSignIn } from '@/lib/guards';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ResendVerificationButton } from '@/components/resend-verification-button';
import { MarketingPreferences } from '@/components/marketing-preferences';

export const metadata: Metadata = { title: 'Your account', robots: { index: false } };

const SECTIONS = [
  { href: '/orders', title: 'Orders', description: 'What you ordered, and where it is.' },
  {
    href: '/account/subscriptions',
    title: 'Subscriptions',
    description: 'Repeat deliveries: pause, change the card, or cancel.',
  },
  {
    href: '/account/reviews',
    title: 'Reviews',
    description: 'What you have written, published or still being read.',
  },
  { href: '/account/support', title: 'Support', description: 'Your conversations with our team.' },
  { href: '/account/addresses', title: 'Addresses', description: 'Where we deliver.' },
  {
    href: '/account/privacy',
    title: 'Your data',
    description: 'Download a copy, or ask us to delete your account.',
  },
] as const;

interface CustomerProfile {
  customerId: string;
  reference: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  emailVerified: boolean;
  acceptsMarketingEmail: boolean;
  acceptsMarketingSms: boolean;
  createdAt: string;
}

export default async function AccountPage() {
  const user = await currentUser();
  const profile = await apiRequestOrSignIn<CustomerProfile>('/api/v1/me/profile');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your account"
        description="Your details, how we contact you, and where we send your orders."
      />

      {!profile.emailVerified ? (
        <Alert tone="warning" title="Confirm your email address">
          <p>
            We sent a confirmation link when you signed up. Confirming your address lets us send
            order updates and lets you reset your password.
          </p>
          <div className="mt-3">
            <ResendVerificationButton />
          </div>
        </Alert>
      ) : null}

      <Card>
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-slate-900">Profile</h2>
          <Badge tone={profile.emailVerified ? 'success' : 'warning'}>
            {profile.emailVerified ? 'Email confirmed' : 'Email unconfirmed'}
          </Badge>
        </div>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-slate-500">Name</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-900">
              {[profile.firstName, profile.lastName].filter(Boolean).join(' ') || '—'}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-slate-500">Email</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-900">{profile.email}</dd>
          </div>
          <div>
            <dt className="text-sm text-slate-500">Phone</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-900">{profile.phone ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-sm text-slate-500">Customer reference</dt>
            <dd className="mt-0.5 font-mono text-sm font-medium text-slate-900">
              {profile.reference}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-slate-500">Member since</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-900">
              {formatDate(profile.createdAt)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-slate-500">Two-factor authentication</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-900">
              {user?.mfaEnabled ? 'On' : 'Off'}{' '}
              <Link
                href="/account/security"
                className="ml-1 font-medium text-brand-700 hover:text-brand-800"
              >
                Manage
              </Link>
            </dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Contact preferences</h2>
        <p className="mt-1 text-sm text-slate-600">
          These control marketing only. We will always send transactional messages about orders,
          payments and account security.
        </p>
        <div className="mt-4">
          <MarketingPreferences
            initial={{
              acceptsMarketingEmail: profile.acceptsMarketingEmail,
              acceptsMarketingSms: profile.acceptsMarketingSms,
            }}
          />
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Everything else</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {SECTIONS.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className="block rounded-lg p-3 ring-1 ring-slate-200 transition-colors hover:bg-slate-50"
              >
                <span className="block text-sm font-semibold text-slate-900">{section.title}</span>
                <span className="mt-0.5 block text-sm text-slate-600">{section.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
