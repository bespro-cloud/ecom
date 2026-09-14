import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { claimTone, getClaim, humanise, type AdminClaim } from '@/lib/compliance';
import { ApiError } from '@/lib/api-client';
import { currentUser } from '@/lib/session';
import { formatDate, formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { ClaimDecisionForm } from '@/components/claim-decision-form';
import { ClaimReviseForm } from '@/components/claim-revise-form';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'Claim' };

/**
 * One claim.
 *
 * Built around the distinction that matters: what a customer currently sees
 * versus what is being worked on. Those are shown as two separate, labelled
 * panels rather than one "text" field, because a screen that collapses them is
 * a screen where somebody edits live health copy by accident.
 *
 * The version history and the decision log are both append-only in the
 * database. Nothing on this page can rewrite either.
 */
export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'CLAIM_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="CLAIM_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;

  let claim: AdminClaim;
  try {
    claim = await getClaim(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const decidable = claim.status === 'UNDER_REVIEW';

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={claim.currentText ?? 'Claim'}
          description={`${humanise(claim.type)} claim on ${claim.product?.name ?? 'a product'}`}
          actions={<Badge tone={claimTone(claim.status)}>{humanise(claim.status)}</Badge>}
        />

        <Link href="/claims" className="inline-block text-sm text-brand-700 hover:underline">
          ← All claims
        </Link>

        {claim.type === 'DISEASE' ? (
          <Alert tone="error" title="This is a disease claim">
            A disease claim cannot lawfully be made about a supplement without the product being
            regulated as a drug. It cannot be approved; recording it here is how the refusal stays
            on file.
          </Alert>
        ) : null}

        {claim.reviewOverdue ? (
          <Alert tone="warning" title="The approval has lapsed">
            This claim has stopped appearing on the listing and needs re-reviewing before it can
            return.
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">What customers see</h2>
              {claim.approvedText ? (
                <>
                  <blockquote className="mt-3 border-l-4 border-emerald-300 bg-emerald-50 px-4 py-3 text-slate-900">
                    {claim.approvedText}
                  </blockquote>
                  <p className="mt-2 text-xs text-slate-500">
                    Version {claim.approvedVersionNumber}, approved{' '}
                    {claim.approvedAt ? formatDateTime(claim.approvedAt) : 'unknown'}
                    {claim.reviewDueAt ? ` · review due ${formatDate(claim.reviewDueAt)}` : ''}
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-slate-600">
                  Nothing. This claim has never been approved, so it does not appear on the listing.
                </p>
              )}

              {claim.hasUnapprovedChanges ? (
                <Alert tone="warning" className="mt-4">
                  The wording below has been edited since that approval. The listing still shows the
                  approved version above.
                </Alert>
              ) : null}
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Current wording</h2>
              <blockquote className="mt-3 border-l-4 border-slate-300 bg-slate-50 px-4 py-3 text-slate-900">
                {claim.currentText}
              </blockquote>
              <p className="mt-2 text-xs text-slate-500">Version {claim.currentVersionNumber}</p>

              <div className="mt-6 border-t border-slate-200 pt-4">
                <h3 className="text-sm font-semibold text-slate-900">Revise the wording</h3>
                <div className="mt-3">
                  <ClaimReviseForm
                    claimId={claim.id}
                    currentText={claim.currentText ?? ''}
                    currentContext={null}
                    isApproved={claim.status === 'APPROVED'}
                    canWrite={hasPermission(user, 'CLAIM_WRITE')}
                  />
                </div>
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Evidence</h2>
              <p className="mt-1 text-sm text-slate-600">{claim.substantiation.detail}</p>

              {claim.evidence.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">No sources are attached.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {claim.evidence.map((entry) => (
                    <li key={entry.linkId} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium text-slate-900">{entry.title}</span>
                        <div className="flex gap-2">
                          <Badge tone={entry.relevance === 'CONTRADICTORY' ? 'warning' : 'neutral'}>
                            {humanise(entry.relevance)}
                          </Badge>
                          <Badge tone={entry.status === 'ACCEPTED' ? 'success' : 'neutral'}>
                            {humanise(entry.status)}
                          </Badge>
                        </div>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{entry.citation}</p>
                      <dl className="mt-2 space-y-1 text-sm">
                        <Row label="Population" value={entry.population} />
                        <Row label="Dosage" value={entry.dosage} />
                        <Row label="Duration" value={entry.duration} />
                        <Row label="Outcome" value={entry.outcome} />
                        <Row label="Limitations" value={entry.limitations} emphasise />
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Decisions</h2>
              <p className="mt-1 text-sm text-slate-600">
                Append-only. A decision cannot be edited or removed once recorded.
              </p>
              {claim.reviews.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">No decision has been recorded.</p>
              ) : (
                <ol className="mt-4 space-y-3">
                  {claim.reviews.map((review) => (
                    <li key={review.id} className="border-l-2 border-slate-200 pl-4">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Badge tone={review.decision === 'APPROVED' ? 'success' : 'warning'}>
                          {humanise(review.decision)}
                        </Badge>
                        <span className="text-xs text-slate-500">{review.reviewerLabel}</span>
                        <span className="text-xs text-slate-400">
                          {formatDateTime(review.decidedAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-800">{review.notes}</p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Decide</h2>
              <div className="mt-3">
                {decidable ? (
                  <ClaimDecisionForm
                    claimId={claim.id}
                    versionId={claim.currentVersionId}
                    versionNumber={claim.currentVersionNumber}
                    claimType={claim.type}
                    substantiation={claim.substantiation}
                    canDecide={hasPermission(user, 'CLAIM_APPROVE')}
                    mfaEnabled={user.mfaEnabled}
                  />
                ) : (
                  <p className="text-sm text-slate-600">
                    This claim is {humanise(claim.status)} and is not currently awaiting a decision.
                  </p>
                )}
              </div>
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-slate-900">Version history</h2>
              <p className="mt-1 text-xs text-slate-500">
                Every version ever written, kept permanently.
              </p>
              <ol className="mt-3 space-y-3">
                {claim.versions.map((version) => (
                  <li key={version.id} className="text-sm">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-slate-900">v{version.version}</span>
                      <span className="text-xs text-slate-400">
                        {formatDateTime(version.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-slate-800">{version.text}</p>
                    {version.changeReason ? (
                      <p className="mt-0.5 text-xs text-slate-500">{version.changeReason}</p>
                    ) : null}
                    <p className="text-xs text-slate-400">{version.authorLabel}</p>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
}

function Row({ label, value, emphasise }: { label: string; value: string; emphasise?: boolean }) {
  return (
    <div className="sm:flex sm:gap-2">
      <dt className="shrink-0 text-slate-500 sm:w-24">{label}</dt>
      <dd className={emphasise ? 'font-medium text-amber-900' : 'text-slate-700'}>{value}</dd>
    </div>
  );
}
