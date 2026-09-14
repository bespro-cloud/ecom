import type { Metadata } from 'next';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { fetchConsentHistory, fetchErasureScope } from '@/lib/lifecycle';
import { formatDateTime } from '@/lib/format';
import { DataExportButton } from '@/components/data-export-button';
import { ErasureRequestForm } from '@/components/erasure-request-form';

export const metadata: Metadata = { title: 'Your data', robots: { index: false } };

const CONSENT_LABEL: Record<string, string> = {
  MARKETING_EMAIL: 'Marketing email',
  MARKETING_SMS: 'Marketing text messages',
  TERMS: 'Terms of sale',
  PRIVACY_POLICY: 'Privacy policy',
};

/**
 * The privacy screen.
 *
 * What deletion would and would not remove is shown **before** the customer
 * asks, not after — and the retained list is the API's, so this page cannot
 * quietly promise something the erasure routine does not do.
 */
export default async function PrivacyPage() {
  const [scope, consents] = await Promise.all([fetchErasureScope(), fetchConsentHistory()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your data"
        description="What we hold, what you agreed to, and how to get it back or have it removed."
      />

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Download your data</h2>
        <p className="mt-1 max-w-prose text-sm text-slate-600">
          A machine-readable copy of your account, orders, addresses, reviews, subscriptions and
          support conversations.
        </p>
        <div className="mt-4">
          <DataExportButton />
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">What you agreed to, and when</h2>
        {consents.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {consents.map((consent) => (
              <li
                key={consent.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-sm last:border-0"
              >
                <span className="font-medium text-slate-900">
                  {CONSENT_LABEL[consent.type] ?? consent.type}
                  {consent.documentVersion ? (
                    <span className="ml-1 font-normal text-slate-500">
                      (version {consent.documentVersion})
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-3">
                  <Badge tone={consent.granted ? 'success' : 'neutral'}>
                    {consent.granted ? 'Given' : 'Withdrawn'}
                  </Badge>
                  <span className="text-slate-500">{formatDateTime(consent.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-sm text-slate-500">
          This history is append-only. Withdrawing consent adds an entry rather than erasing the one
          before it, so there is always a record of what you agreed to at the time.
        </p>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Delete your account</h2>
        <p className="mt-1 max-w-prose text-sm text-slate-600">{scope.note}</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">What we would remove</h3>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {scope.removed.map((entry) => (
                <li key={entry}>• {entry}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">What we have to keep</h3>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {scope.retained.map((entry) => (
                <li key={entry}>• {entry}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-4">
          <Alert tone="warning" title="Why we keep some things">
            <p>
              Orders and payments are required for tax and consumer-protection records, and the
              record of which lots you received is what lets us reach you if a product is recalled.
              Removing those would mean we could not warn you.
            </p>
          </Alert>
        </div>

        <div className="mt-6 border-t border-slate-200 pt-6">
          <ErasureRequestForm />
        </div>
      </Card>
    </div>
  );
}
