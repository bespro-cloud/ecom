import type { Metadata } from 'next';
import { Alert, Badge, Card, PageHeader, TableShell, Td, Th } from '@health/ui';
import { fetchAiStatus, fetchAiUsage, formatMicros, humanise, listInteractions } from '@/lib/ai';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'AI interaction log' };

const OUTCOME_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  COMPLETED: 'success',
  BLOCKED: 'danger',
  FAILED: 'danger',
  NO_GROUNDING: 'warning',
  REFUSED: 'warning',
};

/**
 * Every call, including the ones that never reached a model.
 *
 * The rows worth reading are the ones that are not `COMPLETED`. `NO_GROUNDING`
 * means retrieval found nothing approved and so no request was sent — the case
 * where a model would otherwise have answered from memory. `BLOCKED` means text
 * came back and the guardrails refused it; the text is recorded here and was
 * never returned to whoever asked. Both are normal operation, and a deployment
 * where neither ever appears is more likely to have broken guardrails than
 * perfect prompts.
 *
 * The prompts shown are the redacted ones, exactly as sent. The originals are
 * not stored anywhere, which is what makes this table safe to keep and safe to
 * put on a screen.
 *
 * Gated on `AI_CONFIGURE` rather than `AI_USE`: the people who ask for drafts
 * do not need to read everybody else's prompts.
 */
export default async function AiLogPage({
  searchParams,
}: {
  searchParams: Promise<{ purpose?: string; outcome?: string }>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'AI_CONFIGURE')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="AI_CONFIGURE" />
      </ConsoleShell>
    );
  }

  const status = await fetchAiStatus();

  if (!status.enabled) {
    return (
      <ConsoleShell user={user}>
        <div className="space-y-6">
          <PageHeader title="AI interaction log" description="No AI provider is configured." />
          <Alert tone="info" title="Nothing to log">
            AI assistance is switched off on this deployment, so no requests are being made.
          </Alert>
        </div>
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '100' });
  if (params.purpose) query.set('purpose', params.purpose);
  if (params.outcome) query.set('outcome', params.outcome);

  const [{ data, meta }, usage] = await Promise.all([
    listInteractions(query.toString()),
    fetchAiUsage(),
  ]);

  const spentPercent =
    usage.limitMicros > 0
      ? Math.min(100, Math.round((usage.spentMicros / usage.limitMicros) * 100))
      : 0;

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="AI interaction log"
          description="Append-only. Every request, every refusal, and every request that was never sent."
        />

        {!status.isRealModel ? (
          <Alert tone="warning" title="Development stand-in">
            <p>
              This deployment is configured with the development stand-in rather than a model
              provider. The rows below record what the stand-in returned. Costs are zero because no
              request left the building.
            </p>
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <p className="text-sm text-slate-500">Spent today ({usage.day})</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {formatMicros(usage.spentMicros)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              of {formatMicros(usage.limitMicros)} — {spentPercent}%
            </p>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="img"
              aria-label={`${spentPercent}% of today's AI budget spent`}
            >
              <div
                className={spentPercent >= 90 ? 'h-full bg-rose-500' : 'h-full bg-brand-600'}
                style={{ width: `${spentPercent}%` }}
              />
            </div>
          </Card>
          <Card>
            <p className="text-sm text-slate-500">Calls today</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{usage.calls}</p>
            <p className="mt-1 text-xs text-slate-500">
              {formatMicros(usage.remainingMicros)} of budget left
            </p>
          </Card>
          <Card>
            <p className="text-sm text-slate-500">Tokens today</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {usage.inputTokens.toLocaleString('en-US')} in ·{' '}
              {usage.outputTokens.toLocaleString('en-US')} out
            </p>
          </Card>
          <Card>
            <p className="text-sm text-slate-500">Outcomes today</p>
            {usage.byOutcome.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">Nothing yet.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm text-slate-700">
                {usage.byOutcome.map((row) => (
                  <li key={row.outcome}>
                    <Badge tone={OUTCOME_TONE[row.outcome] ?? 'neutral'}>
                      {humanise(row.outcome)}
                    </Badge>{' '}
                    {row.calls}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {usage.byPurpose.length > 0 ? (
          <Card>
            <h2 className="text-sm font-semibold text-slate-900">Spend by purpose, today</h2>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {usage.byPurpose.map((row) => (
                <li key={row.purpose} className="flex justify-between gap-4">
                  <span>{humanise(row.purpose)}</span>
                  <span className="text-slate-500">
                    {row.calls} call{row.calls === 1 ? '' : 's'} · {formatMicros(row.costMicros)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <TableShell caption="AI interactions, newest first">
          <thead className="bg-slate-50">
            <tr>
              <Th>When</Th>
              <Th>Purpose</Th>
              <Th>Outcome</Th>
              <Th>Who asked</Th>
              <Th>Prompt as sent</Th>
              <Th>Result</Th>
              <Th>Cost</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap text-xs">
                  <time dateTime={row.createdAt}>{formatDateTime(row.createdAt)}</time>
                </Td>
                <Td className="text-xs">
                  <span className="block">{humanise(row.purpose)}</span>
                  <span className="block font-mono text-slate-400">
                    {row.model}
                    {row.isRealModel ? '' : ' (stand-in)'}
                  </span>
                </Td>
                <Td>
                  <Badge tone={OUTCOME_TONE[row.outcome] ?? 'neutral'}>
                    {humanise(row.outcome)}
                  </Badge>
                </Td>
                <Td className="text-xs">{row.actorLabel}</Td>
                <Td className="max-w-sm text-xs">
                  <details>
                    <summary className="cursor-pointer text-brand-700">
                      {row.wasRedacted ? 'Prompt (redacted before sending)' : 'Prompt'}
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-[11px] leading-tight text-slate-700">
                      {row.systemPrompt}
                      {'\n\n---\n\n'}
                      {row.userPrompt}
                    </pre>
                  </details>
                  {row.retrievedIds.length > 0 ? (
                    <span className="mt-1 block font-mono text-[11px] text-slate-400">
                      {row.retrievedIds.join(', ')}
                    </span>
                  ) : (
                    <span className="mt-1 block text-[11px] text-slate-400">
                      No approved sources retrieved.
                    </span>
                  )}
                </Td>
                <Td className="max-w-sm text-xs">
                  {row.blockedReason ? (
                    <p className="font-medium text-rose-700">{row.blockedReason}</p>
                  ) : null}
                  {row.responseText ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-brand-700">
                        {row.outcome === 'BLOCKED' ? 'Refused text (never returned)' : 'Output'}
                      </summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-[11px] leading-tight text-slate-700">
                        {row.responseText}
                      </pre>
                    </details>
                  ) : row.outcome === 'NO_GROUNDING' ? (
                    <p className="text-slate-500">No request was sent.</p>
                  ) : null}
                  {row.guardrailFindings && row.guardrailFindings.length > 0 ? (
                    <ul className="mt-1 space-y-1">
                      {row.guardrailFindings.map((finding, index) => (
                        <li key={`${finding.code}-${index}`} className="text-slate-700">
                          <Badge tone={finding.severity === 'block' ? 'danger' : 'warning'}>
                            {finding.code}
                          </Badge>{' '}
                          {finding.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap text-xs">
                  <span className="block">{formatMicros(row.costMicros)}</span>
                  <span className="block text-slate-400">
                    {row.inputTokens}/{row.outputTokens} tok · {row.latencyMs}ms
                  </span>
                </Td>
              </tr>
            ))}
            {data.length === 0 ? (
              <tr>
                <Td className="py-8 text-center text-slate-500">
                  No interactions match this filter.
                </Td>
              </tr>
            ) : null}
          </tbody>
        </TableShell>

        <p className="text-sm text-slate-500">
          Showing {data.length} record{data.length === 1 ? '' : 's'}
          {meta.hasMore ? ' (more available)' : ''}. This table is append-only in the database: a
          trigger rejects updates and deletes, so nobody can tidy a bad answer out of the record.
        </p>
      </div>
    </ConsoleShell>
  );
}
