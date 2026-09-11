import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { getCompliancePacket, type ComplianceReview } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { PublishChecklist } from '@/components/publish-checklist';
import { ComplianceDecisionForm } from '@/components/compliance-decision-form';

export const metadata: Metadata = { title: 'Compliance review' };

const DECISION_TONES: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  APPROVED: 'success',
  REJECTED: 'danger',
  CHANGES_REQUESTED: 'warning',
};

export default async function ComplianceReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'COMPLIANCE_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="COMPLIANCE_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;
  const packet = await getCompliancePacket(id);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={`Review: ${packet.product.name}`}
          description={`${packet.product.sku} · ${packet.product.type.toLowerCase()}`}
          actions={
            <Link
              href={`/catalogue/${packet.product.id}`}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open product
            </Link>
          }
        />

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-6">
            <Card>
              <PublishChecklist readiness={packet.readiness} />
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Decision history</h2>
              <p className="mt-1 text-sm text-slate-600">
                Append-only, enforced by the database. A decision that could be edited afterwards
                would not be evidence of anything.
              </p>

              {packet.history.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">No decision has been recorded yet.</p>
              ) : (
                <ol className="mt-4 space-y-4">
                  {packet.history.map((review) => (
                    <ReviewEntry key={review.id} review={review} />
                  ))}
                </ol>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Record a decision</h2>
              <div className="mt-4">
                <ComplianceDecisionForm
                  productId={packet.product.id}
                  canDecide={hasPermission(user, 'COMPLIANCE_APPROVE')}
                />
              </div>
            </Card>

            <Alert tone="info" title="What this screen is for">
              <p>
                A decision here is a statement by a named person that they checked this listing
                against the documentation held for it. The checklist above is snapshotted with the
                decision, so it is possible to say later exactly what you were looking at.
              </p>
            </Alert>
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
}

function ReviewEntry({ review }: { review: ComplianceReview }) {
  const snapshot = review.checklistSnapshot as
    | { ready?: boolean; checks?: Array<{ key: string; state: string; detail: string | null }> }
    | null
    | undefined;
  const failing = snapshot?.checks?.filter((check) => check.state === 'FAIL') ?? [];

  return (
    <li className="rounded-lg bg-slate-50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={DECISION_TONES[review.decision] ?? 'neutral'}>
          {review.decision.toLowerCase().replace(/_/g, ' ')}
        </Badge>
        <span className="text-sm text-slate-700">{review.reviewerLabel}</span>
        <span className="text-sm text-slate-500">{formatDateTime(review.decidedAt)}</span>
        {review.reviewDueAt ? (
          <span className="text-sm text-slate-500">
            · due for re-review {formatDateTime(review.reviewDueAt)}
          </span>
        ) : null}
      </div>

      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{review.notes}</p>

      {snapshot ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            Checklist at the time of this decision
          </summary>
          <p className="mt-2 text-sm text-slate-600">
            {snapshot.ready
              ? 'Every check was satisfied.'
              : failing.length === 0
                ? 'No failing checks were recorded.'
                : `${failing.length} check${failing.length === 1 ? '' : 's'} were outstanding:`}
          </p>
          {failing.length > 0 ? (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">
              {failing.map((check) => (
                <li key={check.key}>
                  <span className="font-medium">{check.key.toLowerCase().replace(/_/g, ' ')}</span>
                  {check.detail ? `: ${check.detail}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}
