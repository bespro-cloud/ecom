import { Badge } from '@health/ui';
import type { PublishCheck, PublishCheckState, PublishReadiness } from '@/lib/catalogue';

/**
 * The publishing checklist, as an operator sees it.
 *
 * The design rule here matches the service behind it: **every check is shown,
 * whatever its state.** A checklist that hides what it did not evaluate looks
 * like assurance it cannot give, and the person reading this screen is deciding
 * whether to put a health product in front of customers.
 *
 * So `NOT_YET_ENFORCED` is rendered as its own visible state with the phase
 * that will implement it, not folded into "passed" or quietly dropped; and a
 * finding an operator excluded from the required set still shows what was
 * found, with a note that it is not blocking.
 */

const STATE_PRESENTATION: Record<
  PublishCheckState,
  { tone: 'success' | 'danger' | 'neutral' | 'warning'; label: string }
> = {
  PASS: { tone: 'success', label: 'Passed' },
  FAIL: { tone: 'danger', label: 'Blocking' },
  NOT_APPLICABLE: { tone: 'neutral', label: 'Not applicable' },
  NOT_YET_ENFORCED: { tone: 'warning', label: 'Not yet enforced' },
};

function CheckRow({ check }: { check: PublishCheck }) {
  const presentation = STATE_PRESENTATION[check.state];

  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 shrink-0">
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{check.label}</p>
        <p className="mt-0.5 text-sm text-slate-600">{check.description}</p>
        {check.detail ? (
          <p
            className={`mt-1 text-sm ${
              check.state === 'FAIL' ? 'font-medium text-red-700' : 'text-slate-500'
            }`}
          >
            {check.detail}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function PublishChecklist({ readiness }: { readiness: PublishReadiness }) {
  const blocking = readiness.checks.filter((check) => check.state === 'FAIL');
  const rest = readiness.checks.filter((check) => check.state !== 'FAIL');

  return (
    <section aria-labelledby="checklist-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="checklist-heading" className="text-lg font-semibold text-slate-900">
          Publishing checklist
        </h2>
        <Badge tone={readiness.ready ? 'success' : 'danger'}>
          {readiness.ready
            ? 'Ready to publish'
            : `${blocking.length} outstanding ${blocking.length === 1 ? 'check' : 'checks'}`}
        </Badge>
      </div>

      <p className="mt-1 text-sm text-slate-600">
        Evaluated against the product as it stands right now. It is re-evaluated at the moment you
        publish, so a change made after this screen loaded cannot slip past.
      </p>

      {readiness.notYetEnforced.length > 0 ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {readiness.notYetEnforced.length} check
          {readiness.notYetEnforced.length === 1 ? '' : 's'} cannot be evaluated yet because the
          domain behind {readiness.notYetEnforced.length === 1 ? 'it does' : 'them does'} not exist
          in this build. {readiness.notYetEnforced.length === 1 ? 'It is' : 'They are'} listed below
          rather than counted as passed — nothing here is claiming they were checked.
        </p>
      ) : null}

      <ul className="mt-4 divide-y divide-slate-100">
        {blocking.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
        {rest.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </ul>
    </section>
  );
}
