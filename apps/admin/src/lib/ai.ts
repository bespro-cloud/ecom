import 'server-only';
import { apiRequestOrSignIn } from './guards';

/**
 * Admin-side AI types.
 *
 * Two naming choices are carried to the screen deliberately.
 *
 * `isRealModel` mirrors `isRealMoney` on a payment. When it is false the output
 * came from a development stand-in, and every screen that shows the text says
 * so — the same way an order paid through the development payment provider is
 * labelled.
 *
 * `findings` rather than `warnings`. These are what the guardrails matched, and
 * a blocking finding is not a warning about text somebody may use anyway: the
 * text is not returned at all.
 */

const AI = '/api/v1/admin/ai';

export interface AiStatus {
  enabled: boolean;
  provider: string;
  isRealModel: boolean;
  /** What AI is never asked to do. Shown so the boundary is on the screen. */
  prohibited: string[];
}

export interface GuardrailFinding {
  code: string;
  severity: 'block' | 'flag';
  evidence: string;
  message: string;
}

export interface AiSuggestion {
  id: string;
  kind: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
  targetType: string | null;
  targetId: string | null;
  content: {
    text?: string | null;
    title?: string | null;
    description?: string | null;
    refused?: string;
  } | null;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  createdAt: string;
  purpose: string;
  provider: string;
  model: string;
  isRealModel: boolean;
  sourceIds: string[];
  findings: GuardrailFinding[];
}

export interface AiInteraction {
  id: string;
  purpose: string;
  outcome: 'COMPLETED' | 'BLOCKED' | 'NO_GROUNDING' | 'REFUSED' | 'FAILED';
  provider: string;
  model: string;
  isRealModel: boolean;
  systemPrompt: string;
  /** The redacted prompt, exactly as sent. The original is never stored. */
  userPrompt: string;
  wasRedacted: boolean;
  responseText: string | null;
  retrievedIds: string[];
  guardrailFindings: GuardrailFinding[] | null;
  blockedReason: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  actorLabel: string;
  createdAt: string;
}

export interface AiUsage {
  day: string;
  calls: number;
  spentMicros: number;
  limitMicros: number;
  remainingMicros: number;
  inputTokens: number;
  outputTokens: number;
  byOutcome: Array<{ outcome: string; calls: number }>;
  byPurpose: Array<{ purpose: string; calls: number; costMicros: number }>;
}

export async function fetchAiStatus(): Promise<AiStatus> {
  return apiRequestOrSignIn<AiStatus>(`${AI}/status`);
}

export async function listSuggestions(query = 'limit=100'): Promise<{
  data: AiSuggestion[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${AI}/suggestions?${query}`);
}

export async function getSuggestion(id: string): Promise<AiSuggestion> {
  return apiRequestOrSignIn<AiSuggestion>(`${AI}/suggestions/${encodeURIComponent(id)}`);
}

export async function listInteractions(query = 'limit=100'): Promise<{
  data: AiInteraction[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${AI}/interactions?${query}`);
}

export async function fetchAiUsage(): Promise<AiUsage> {
  return apiRequestOrSignIn<AiUsage>(`${AI}/usage`);
}

/** Hundredths of a cent, as money. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

export function humanise(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
