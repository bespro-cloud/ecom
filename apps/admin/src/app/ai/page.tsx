import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { fetchAiStatus, humanise, listSuggestions } from '@/lib/ai';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { AiSuggestionDecision } from '@/components/ai-suggestion-decision';

export const metadata: Metadata = { title: 'AI assistance' };

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'neutral',
  BLOCKED: 'danger',
};

/**
 * The suggestion queue.
 *
 * Everything AI produced, waiting for a person — including the things the
 * guardrails refused, which sit here visibly in `BLOCKED` rather than vanishing.
 * Somebody reviewing how this feature behaves needs the near-misses, and a
 * queue that showed only the acceptable output would be a queue that looks
 * better than the system is.
 */
export default async function AiPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'AI_USE')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="AI_USE" />
      </ConsoleShell>
    );
  }

  const status = await fetchAiStatus();

  if (!status.enabled) {
    return (
      <ConsoleShell user={user}>
        <div className="space-y-6">
          <PageHeader title="AI assistance" description="Not enabled on this deployment." />
          <Alert tone="info" title="No AI provider is configured">
            <p>
              That is a supported configuration, not a broken one — the platform works without it.
              Set <code className="font-mono">AI_PROVIDER</code> and a daily budget to switch it on.
            </p>
          </Alert>
        </div>
      </ConsoleShell>
    );
  }

  const { data } = await listSuggestions('limit=100');
  const pending = data.filter((row) => row.status === 'PENDING');
  const blocked = data.filter((row) => row.status === 'BLOCKED');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="AI assistance"
          description="Everything a model proposed, waiting for a person to decide."
        />

        {!status.isRealModel ? (
          <Alert tone="warning" title="This is a development stand-in, not a model">
            <p>
              The text below was produced by a stand-in so the guardrails, the audit trail and these
              screens can be exercised without an API key. It is not model output and must not be
              treated as any kind of answer.
            </p>
          </Alert>
        ) : null}

        <Alert tone="info" title="What this will not do">
          <ul className="mt-1 space-y-1">
            {status.prohibited.map((entry) => (
              <li key={entry}>• {entry}</li>
            ))}
          </ul>
          <p className="mt-2">
            None of these is a policy somebody could change in a settings screen. There is no
            request that expresses them and no suggestion type that could carry one out.
          </p>
        </Alert>

        {blocked.length > 0 ? (
          <Alert tone="error" title={`${blocked.length} output(s) were refused by the guardrails`}>
            They are listed below so the near-misses are visible. None of them can be accepted.
          </Alert>
        ) : null}

        {data.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="Suggestions appear here when somebody asks for help drafting or summarising."
          />
        ) : (
          <ul className="space-y-4">
            {data.map((suggestion) => (
              <li key={suggestion.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={TONE[suggestion.status] ?? 'neutral'}>
                        {humanise(suggestion.status)}
                      </Badge>
                      <span className="text-sm font-medium text-slate-900">
                        {humanise(suggestion.purpose)}
                      </span>
                      {!suggestion.isRealModel ? (
                        <Badge tone="warning">Stand-in, not a model</Badge>
                      ) : null}
                    </div>
                    <span className="text-sm text-slate-500">
                      {suggestion.requestedBy} · {formatDateTime(suggestion.createdAt)}
                    </span>
                  </div>

                  {suggestion.status === 'BLOCKED' ? (
                    <div className="mt-3">
                      <Alert tone="error" title="Refused">
                        <p>{suggestion.content?.refused ?? 'The guardrails refused this text.'}</p>
                      </Alert>
                    </div>
                  ) : (
                    <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">
                      {suggestion.content?.text ??
                        [suggestion.content?.title, suggestion.content?.description]
                          .filter(Boolean)
                          .join('\n') ??
                        '(nothing)'}
                    </pre>
                  )}

                  {suggestion.findings.length > 0 ? (
                    <ul className="mt-3 space-y-1 text-sm">
                      {suggestion.findings.map((finding, index) => (
                        <li key={`${finding.code}-${index}`} className="text-slate-700">
                          <Badge tone={finding.severity === 'block' ? 'danger' : 'warning'}>
                            {finding.code}
                          </Badge>{' '}
                          {finding.message}
                          {finding.evidence ? (
                            <span className="text-slate-500"> — matched “{finding.evidence}”</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {suggestion.sourceIds.length > 0 ? (
                    <p className="mt-3 text-sm text-slate-500">
                      Grounded in {suggestion.sourceIds.length} approved record(s):{' '}
                      <span className="font-mono">{suggestion.sourceIds.join(', ')}</span>
                    </p>
                  ) : null}

                  {suggestion.status === 'PENDING' ? (
                    <div className="mt-4 border-t border-slate-200 pt-4">
                      <AiSuggestionDecision suggestionId={suggestion.id} blocked={false} />
                    </div>
                  ) : suggestion.decidedBy ? (
                    <p className="mt-3 border-t border-slate-200 pt-3 text-sm text-slate-600">
                      {humanise(suggestion.status)} by {suggestion.decidedBy}
                      {suggestion.decidedAt ? ` · ${formatDateTime(suggestion.decidedAt)}` : ''}
                      {suggestion.decisionNotes ? ` — “${suggestion.decisionNotes}”` : ''}
                    </p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}

        <p className="text-sm text-slate-500">
          {pending.length} waiting. Nothing here has changed anything: accepting a suggestion writes
          text to a draft, and publishing is a separate act by somebody with the permission to do
          it.
        </p>
      </div>
    </ConsoleShell>
  );
}
