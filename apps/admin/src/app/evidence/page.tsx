import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { humanise, listEvidence } from '@/lib/compliance';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Evidence' };

/**
 * The evidence library.
 *
 * Shown as records rather than a table, because the fields that matter are
 * prose. `limitations` in particular is given the same visual weight as the
 * outcome: a list that showed findings prominently and limitations in small
 * grey text would be a sales document, which is precisely what a substantiation
 * file must not become.
 */
export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'EVIDENCE_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="EVIDENCE_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const single = (key: string): string => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  const query = new URLSearchParams();
  if (single('search')) query.set('search', single('search'));
  if (single('status')) query.set('status', single('status'));
  query.set('limit', '50');

  const { data } = await listEvidence(query.toString());

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Evidence"
          description="Sources a reviewer read, in their own words. Nothing here is fetched from an identifier or summarised by the system — every field was typed by the person who read the study."
        />

        <Alert tone="info">
          A source is shared across claims and products. Correcting it in one place is the point;
          copying it per claim is how substantiation files go stale.
        </Alert>

        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="evidence-search" className="block text-sm font-medium text-slate-700">
                Search
              </label>
              <input
                id="evidence-search"
                type="search"
                name="search"
                defaultValue={single('search')}
                placeholder="Title, citation or identifier"
                maxLength={200}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>

            <div>
              <label htmlFor="evidence-status" className="block text-sm font-medium text-slate-700">
                Status
              </label>
              <select
                id="evidence-status"
                name="status"
                defaultValue={single('status')}
                className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                <option value="">Any</option>
                {['DRAFT', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED'].map((status) => (
                  <option key={status} value={status}>
                    {humanise(status)}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Apply
            </button>
          </form>
        </Card>

        {data.length === 0 ? (
          <Card>
            <EmptyState
              title="No sources match"
              description="Evidence is recorded from a claim, or here as a standalone source."
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {data.map((entry) => (
              <Card key={entry.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold text-slate-900">{entry.title}</h2>
                  <div className="flex gap-2">
                    <Badge>{humanise(entry.sourceType)}</Badge>
                    <Badge tone={entry.status === 'ACCEPTED' ? 'success' : 'neutral'}>
                      {humanise(entry.status)}
                    </Badge>
                  </div>
                </div>
                <p className="mt-1 text-sm text-slate-600">{entry.citation}</p>

                <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="Population" value={entry.population} />
                  <Field label="Dosage" value={entry.dosage} />
                  <Field label="Duration" value={entry.duration} />
                  <Field label="Outcome" value={entry.outcome} />
                </dl>

                <div className="mt-3 rounded-lg bg-amber-50 p-3 ring-1 ring-inset ring-amber-200">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                    Limitations
                  </dt>
                  <dd className="mt-1 text-sm text-amber-900">{entry.limitations}</dd>
                </div>

                <p className="mt-3 text-xs text-slate-500">
                  Added by {entry.addedByLabel} on {formatDate(entry.createdAt)}
                  {entry.reviewedByLabel
                    ? ` · reviewed by ${entry.reviewedByLabel}`
                    : ' · not yet reviewed'}
                  {entry.claimCount !== undefined
                    ? ` · attached to ${entry.claimCount} claim(s)`
                    : ''}
                </p>
                {entry.reviewNotes ? (
                  <p className="mt-1 text-sm text-slate-700">{entry.reviewNotes}</p>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </div>
    </ConsoleShell>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
    </div>
  );
}
