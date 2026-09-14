/**
 * AI: what it may do, what it may never do, and how both are enforced.
 *
 * This is the most dangerous subsystem in the platform, and it is worth being
 * explicit about why. A language model asked about a supplement will produce a
 * fluent, confident, well-structured paragraph whether or not it has any basis
 * for it. On a site selling regulated health products, that paragraph is an
 * unapproved health claim in the most convincing possible format — and the
 * failure is silent, because a fabrication reads exactly like a fact.
 *
 * So the design does not rely on the model behaving. It relies on four
 * structural properties, each enforced somewhere the model cannot reach:
 *
 * **AI never completes an action.** Every output is a *suggestion* a named
 * person accepts. There is no suggestion kind that approves a claim, changes a
 * compliance status, publishes anything, issues a refund or moves stock —
 * not "we don't do that", but no enum member that could express it.
 *
 * **AI never answers from its own memory.** Retrieval-backed purposes are
 * grounded in approved records, and when retrieval returns nothing the model is
 * not called at all. "I don't know" is produced by the absence of a request,
 * not by asking a model to be humble.
 *
 * **Fabricated citations are caught.** The answer must cite source ids, and
 * every cited id is checked against what was actually retrieved. A model that
 * invents a plausible-looking reference fails this check mechanically.
 *
 * **Output is scanned before a human ever sees it as acceptable.** Disease
 * claims, FDA-approval assertions, dosage instructions and absolute guarantees
 * block a suggestion outright rather than arriving as a tempting draft.
 *
 * Everything here is pure. Nothing reads a clock, a database or a network.
 */

// ---------------------------------------------------------------------------
// What AI is allowed to be asked for
// ---------------------------------------------------------------------------

/**
 * The complete list of things AI may be asked to do.
 *
 * An allow-list, and a short one. Every entry had to justify itself, and the
 * ones that are missing are missing on purpose — see `PROHIBITED_OF_AI`.
 */
export const AI_PURPOSES = [
  /**
   * A neutral digest of evidence already accepted by a reviewer, for the
   * reviewer's own reading. Explicitly *not* an opinion on whether the evidence
   * substantiates anything: that judgement is the reviewer's and is the reason
   * the role exists.
   */
  'EVIDENCE_DIGEST',
  /** Draft descriptive copy for a product. Never claims; see the guardrails. */
  'PRODUCT_COPY_DRAFT',
  /** Draft a page title and meta description. */
  'SEO_METADATA_DRAFT',
  /** Draft an outline for an article. */
  'BLOG_OUTLINE_DRAFT',
  /** Narrate a rollup that has already been computed. */
  'ANALYTICS_SUMMARY',
  /** Draft a reply to a support conversation. Non-clinical by construction. */
  'SUPPORT_REPLY_DRAFT',
  /** Answer a staff question from approved records, with citations. */
  'KNOWLEDGE_ANSWER',
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/**
 * Things AI is never asked to do, written down so the absence is deliberate
 * rather than an oversight somebody fills in later.
 *
 * This list is documentation with teeth: a test asserts that no `AiPurpose` and
 * no `AiSuggestionKind` corresponds to any of them.
 */
export const PROHIBITED_OF_AI: readonly string[] = [
  'approve or reject a product claim',
  'change a compliance status',
  'decide whether evidence substantiates a claim',
  'publish anything to the storefront',
  'moderate a customer review',
  'approve a blog post that names a product',
  'issue a refund or adjust a payment',
  'adjust inventory or release quarantined stock',
  'approve contacting customers about a recall',
  'decide a data erasure request',
  'grant, change or bypass a permission',
  'answer a customer question about their own health',
];

/**
 * Whether a purpose is grounded in retrieved records.
 *
 * For these, an empty retrieval means the model is not called. For the rest,
 * the input *is* the grounding: an analytics summary is given the numbers, a
 * support draft is given the conversation.
 */
export const RETRIEVAL_GROUNDED_PURPOSES: readonly AiPurpose[] = [
  'EVIDENCE_DIGEST',
  'KNOWLEDGE_ANSWER',
];

export function requiresRetrieval(purpose: AiPurpose): boolean {
  return RETRIEVAL_GROUNDED_PURPOSES.includes(purpose);
}

/**
 * Purposes whose output is destined for a customer's eyes.
 *
 * These get the strict guardrail treatment: a finding blocks rather than flags.
 * Copy that reaches a public listing is the path where a fabricated claim does
 * real regulatory damage, and a "draft" a human might accept in a hurry is not
 * meaningfully safer than publishing it directly.
 */
export const CUSTOMER_FACING_PURPOSES: readonly AiPurpose[] = [
  'PRODUCT_COPY_DRAFT',
  'SEO_METADATA_DRAFT',
  'BLOG_OUTLINE_DRAFT',
  'SUPPORT_REPLY_DRAFT',
];

export function isCustomerFacing(purpose: AiPurpose): boolean {
  return CUSTOMER_FACING_PURPOSES.includes(purpose);
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * What an accepted suggestion actually changes.
 *
 * Note what is not here, because this enum is the enforcement: there is no
 * member that approves a claim, sets a compliance status, publishes a page or
 * touches money or stock. Applying a suggestion writes descriptive text to a
 * draft, and nothing else.
 */
export const AI_SUGGESTION_KINDS = [
  /** Replaces a product's *draft* short/long description. Never a claim. */
  'PRODUCT_DESCRIPTION',
  /** Fills SEO title and description for an entity. */
  'SEO_METADATA',
  /** Adds an outline to a blog post draft. Publishing it is a separate act. */
  'BLOG_OUTLINE',
  /** Puts proposed text in a support composer. A person sends it. */
  'SUPPORT_REPLY',
  /**
   * Text only, applied to nothing. A digest or an answer the requester reads.
   * Kept as a suggestion so it is audited and attributable like the rest.
   */
  'ADVISORY_NOTE',
] as const;
export type AiSuggestionKind = (typeof AI_SUGGESTION_KINDS)[number];

export const AI_SUGGESTION_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'BLOCKED'] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

const SUGGESTION_FOR_PURPOSE: Record<AiPurpose, AiSuggestionKind> = {
  EVIDENCE_DIGEST: 'ADVISORY_NOTE',
  PRODUCT_COPY_DRAFT: 'PRODUCT_DESCRIPTION',
  SEO_METADATA_DRAFT: 'SEO_METADATA',
  BLOG_OUTLINE_DRAFT: 'BLOG_OUTLINE',
  ANALYTICS_SUMMARY: 'ADVISORY_NOTE',
  SUPPORT_REPLY_DRAFT: 'SUPPORT_REPLY',
  KNOWLEDGE_ANSWER: 'ADVISORY_NOTE',
};

export function suggestionKindFor(purpose: AiPurpose): AiSuggestionKind {
  return SUGGESTION_FOR_PURPOSE[purpose];
}

// ---------------------------------------------------------------------------
// Output guardrails
// ---------------------------------------------------------------------------

export type GuardrailCode =
  | 'disease_claim'
  | 'regulatory_assertion'
  | 'dosage_instruction'
  | 'absolute_guarantee'
  | 'unverifiable_certification'
  | 'fabricated_citation'
  | 'ungrounded_answer'
  | 'clinical_advice';

export type GuardrailSeverity = 'block' | 'flag';

export interface GuardrailFinding {
  code: GuardrailCode;
  severity: GuardrailSeverity;
  /** The matched text, so a person can see what tripped it. */
  evidence: string;
  message: string;
}

export interface GuardrailVerdict {
  /** True when nothing blocking was found. A flagged output is still allowed. */
  allowed: boolean;
  findings: GuardrailFinding[];
}

/**
 * Language that states or implies a product treats, prevents or cures disease.
 *
 * Phrases rather than bare words, because a bare word list over generated prose
 * is close to useless in both directions: "treatment" appears in "water
 * treatment", and a fabricated claim can avoid every single word on a list. The
 * value here is catching the *common shapes* a model produces when it drifts,
 * which it does in remarkably predictable ways.
 *
 * This is a net, not a proof. It is one of four defences, and the load-bearing
 * ones are that copy is never published by the model and that claims come from
 * the claims table.
 */
const DISEASE_CLAIM_PATTERNS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\b(cure|cures|curing|cured)\b/i, evidence: 'cure' },
  { pattern: /\b(treats?|treating|treated)\s+(your|the|a|an)?\s*\w+/i, evidence: 'treats' },
  { pattern: /\bprevents?\b/i, evidence: 'prevents' },
  { pattern: /\breverses?\b/i, evidence: 'reverses' },
  { pattern: /\b(heals?|healing)\b/i, evidence: 'heals' },
  { pattern: /\b(remedy|remedies)\s+for\b/i, evidence: 'remedy for' },
  { pattern: /\b(alleviates?|relieves?)\s+(symptoms?|pain)\b/i, evidence: 'relieves symptoms' },
  { pattern: /\bdiagnos(e|es|ing|is)\b/i, evidence: 'diagnose' },
  {
    pattern:
      /\b(cancer|diabetes|alzheimer'?s|arthritis|depression|hypertension|covid|influenza|dementia|osteoporosis)\b/i,
    evidence: 'a named disease',
  },
];

/** Claims of a regulatory status the business has not got and cannot assert. */
const REGULATORY_PATTERNS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\bfda[\s-]*(approved|cleared|endorsed|certified)\b/i, evidence: 'FDA approved' },
  { pattern: /\bapproved\s+by\s+the\s+fda\b/i, evidence: 'approved by the FDA' },
  { pattern: /\bclinically\s+(proven|validated)\b/i, evidence: 'clinically proven' },
  { pattern: /\bmedically\s+(proven|approved)\b/i, evidence: 'medically proven' },
  { pattern: /\bdoctor[\s-]*(recommended|approved|endorsed)\b/i, evidence: 'doctor recommended' },
  { pattern: /\bpharmaceutical[\s-]*grade\b/i, evidence: 'pharmaceutical grade' },
];

/** Anything that reads as dosing or medical direction. */
const DOSAGE_PATTERNS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\btake\s+\d+\s*(mg|mcg|g|iu|capsules?|tablets?|pills?)\b/i, evidence: 'a dose' },
  { pattern: /\b\d+\s*(mg|mcg|iu)\s+(daily|twice|per day|a day)\b/i, evidence: 'a daily dose' },
  { pattern: /\b(stop|discontinue)\s+(taking|using)\b/i, evidence: 'stop taking' },
  {
    pattern: /\binstead\s+of\s+(your\s+)?(medication|prescription|medicine)\b/i,
    evidence: 'instead of medication',
  },
  { pattern: /\b(increase|reduce)\s+your\s+dose\b/i, evidence: 'change your dose' },
  { pattern: /\bsafe\s+to\s+take\s+with\b/i, evidence: 'safe to take with' },
];

const ABSOLUTE_PATTERNS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\bguarantee(d|s)?\b/i, evidence: 'guaranteed' },
  { pattern: /\b100\s*%\s*(effective|safe|natural|pure)\b/i, evidence: '100% effective' },
  { pattern: /\b(miracle|miraculous)\b/i, evidence: 'miracle' },
  { pattern: /\bno\s+side\s+effects?\b/i, evidence: 'no side effects' },
  { pattern: /\b(completely|totally)\s+safe\b/i, evidence: 'completely safe' },
  { pattern: /\bworks?\s+for\s+everyone\b/i, evidence: 'works for everyone' },
];

/**
 * Assertions about testing and certification.
 *
 * These are *facts about the product* that live in the documents table, recorded
 * as stated by an uploader and never verified by this system. A model asserting
 * them in prose is inventing a manufacturing fact, which is the same category of
 * error as inventing evidence.
 */
const CERTIFICATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\b(third[\s-]*party|independently)\s+tested\b/i, evidence: 'third-party tested' },
  { pattern: /\bgmp[\s-]*(certified|compliant)\b/i, evidence: 'GMP certified' },
  { pattern: /\bnsf[\s-]*certified\b/i, evidence: 'NSF certified' },
  { pattern: /\b(usda\s+)?organic\s+certified\b/i, evidence: 'organic certified' },
  { pattern: /\blab[\s-]*(tested|verified)\b/i, evidence: 'lab tested' },
];

/** Language that answers a health question rather than declining to. */
const CLINICAL_ADVICE_PATTERNS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\byou\s+should\s+take\b/i, evidence: 'you should take' },
  { pattern: /\bi\s+recommend\s+(taking|that\s+you)\b/i, evidence: 'I recommend taking' },
  { pattern: /\bthis\s+will\s+help\s+(your|with\s+your)\b/i, evidence: 'this will help your' },
  { pattern: /\bfor\s+your\s+(condition|symptoms|diagnosis)\b/i, evidence: 'for your condition' },
];

interface Rule {
  code: GuardrailCode;
  patterns: ReadonlyArray<{ pattern: RegExp; evidence: string }>;
  message: string;
}

const RULES: readonly Rule[] = [
  {
    code: 'disease_claim',
    patterns: DISEASE_CLAIM_PATTERNS,
    message:
      'Reads as a claim that the product treats, prevents or cures a disease. A supplement may not make one.',
  },
  {
    code: 'regulatory_assertion',
    patterns: REGULATORY_PATTERNS,
    message: 'Asserts a regulatory status or endorsement this business has not got.',
  },
  {
    code: 'dosage_instruction',
    patterns: DOSAGE_PATTERNS,
    message: 'Reads as dosing or medical direction. That is a clinician’s job, not a shop’s.',
  },
  {
    code: 'absolute_guarantee',
    patterns: ABSOLUTE_PATTERNS,
    message: 'Promises an outcome or a safety level nobody can promise.',
  },
  {
    code: 'unverifiable_certification',
    patterns: CERTIFICATION_PATTERNS,
    message:
      'States a testing or certification fact. Those come from recorded documents, not from prose.',
  },
  {
    code: 'clinical_advice',
    patterns: CLINICAL_ADVICE_PATTERNS,
    message: 'Reads as advice to an individual about their own health.',
  },
];

/**
 * Scans generated text before anybody is offered it.
 *
 * Severity depends on where the text is going. Copy bound for a customer blocks
 * on any finding; an internal digest flags, because a reviewer reading "the
 * study reported reduced anxiety scores" needs that sentence and is qualified
 * to weigh it. The same words are dangerous on a product page and necessary in
 * a summary of a paper.
 */
export function scanGeneratedText(text: string, purpose: AiPurpose): GuardrailVerdict {
  const customerFacing = isCustomerFacing(purpose);
  const findings: GuardrailFinding[] = [];

  for (const rule of RULES) {
    for (const { pattern, evidence } of rule.patterns) {
      const match = pattern.exec(text);
      if (!match) continue;

      findings.push({
        code: rule.code,
        // Clinical advice blocks everywhere. Telling an individual what to take
        // is not something an internal note makes acceptable, because internal
        // notes get pasted into replies.
        severity:
          customerFacing || rule.code === 'clinical_advice' || rule.code === 'regulatory_assertion'
            ? 'block'
            : 'flag',
        evidence: match[0] ?? evidence,
        message: rule.message,
      });
      break;
    }
  }

  return { allowed: !findings.some((finding) => finding.severity === 'block'), findings };
}

/**
 * Checks that every citation in an answer refers to something actually
 * retrieved.
 *
 * Models invent references. They invent them in exactly the right format, with
 * plausible identifiers, which is what makes the failure dangerous: a reviewer
 * who spot-checks one citation and finds it real has learned nothing about the
 * other four. This check is mechanical and complete.
 *
 * Citations are written `[[id]]` — a form that does not occur in ordinary prose
 * and cannot be confused with Markdown.
 */
export function verifyCitations(
  text: string,
  retrievedIds: readonly string[],
): { cited: string[]; fabricated: string[] } {
  const allowed = new Set(retrievedIds);
  const cited = new Set<string>();
  const fabricated = new Set<string>();

  const pattern = /\[\[([A-Za-z0-9_:-]{1,64})\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const id = match[1]!;
    if (allowed.has(id)) cited.add(id);
    else fabricated.add(id);
  }

  return { cited: [...cited], fabricated: [...fabricated] };
}

/**
 * The grounding verdict for a retrieval-backed answer.
 *
 * A fabricated citation blocks outright. An answer with no citation at all is
 * blocked too: for these purposes an uncited sentence is the model speaking
 * from memory, which is the thing retrieval exists to prevent.
 */
export function checkGrounding(text: string, retrievedIds: readonly string[]): GuardrailFinding[] {
  const { cited, fabricated } = verifyCitations(text, retrievedIds);
  const findings: GuardrailFinding[] = [];

  if (fabricated.length > 0) {
    findings.push({
      code: 'fabricated_citation',
      severity: 'block',
      evidence: fabricated.join(', '),
      message:
        'Cites sources that were not retrieved. The model invented a reference, which is the failure this check exists for.',
    });
  }

  if (cited.length === 0) {
    findings.push({
      code: 'ungrounded_answer',
      severity: 'block',
      evidence: '',
      message:
        'Cites nothing. For a grounded answer, an uncited sentence is the model speaking from memory.',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Prompt redaction
// ---------------------------------------------------------------------------

/**
 * Strips personal data out of text before it leaves for a model provider.
 *
 * Sending a customer's email address to a third party is a disclosure, whatever
 * the provider's retention policy says, and on this site the surrounding text
 * may be about a health product. So the rule is simple and absolute: nothing
 * identifying goes out.
 *
 * Deliberately aggressive. Over-redacting costs a slightly worse draft;
 * under-redacting is a data breach with a plausible-sounding explanation.
 */
export function redactForModel(text: string): string {
  return (
    text
      // Email addresses.
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
      // Long digit runs: card numbers, account numbers, anything of that shape.
      .replace(/\b(?:\d[ -]?){12,19}\b/g, '[number]')
      // Phone numbers, loosely.
      .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]')
      // Order and customer references, which are identifiers by another name.
      .replace(/\bHC-[A-Z0-9-]{4,}\b/gi, '[reference]')
      // Anything that looks like a token, key or long opaque identifier.
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
      // US-style street addresses.
      .replace(
        /\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+)*\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct)\b\.?/gi,
        '[address]',
      )
  );
}

/** Whether redaction changed anything — recorded so the audit can say so. */
export function wasRedacted(original: string, redacted: string): boolean {
  return original !== redacted;
}

// ---------------------------------------------------------------------------
// Cost and budget
// ---------------------------------------------------------------------------

/**
 * Cost in hundredths of a cent.
 *
 * Money is an integer here for the same reason it is everywhere else in this
 * codebase, and the extra two digits of precision exist because per-token
 * prices are quoted in fractions of a cent: rounding each call to the nearest
 * cent would turn a month of small calls into a number that is wrong by more
 * than the bill.
 */
export interface ModelPricing {
  inputPerMillionMicros: number;
  outputPerMillionMicros: number;
}

export function computeCostMicros(
  usage: { inputTokens: number; outputTokens: number },
  pricing: ModelPricing,
): number {
  const input = (usage.inputTokens * pricing.inputPerMillionMicros) / 1_000_000;
  const output = (usage.outputTokens * pricing.outputPerMillionMicros) / 1_000_000;
  // Rounded up: a cost report that under-states is worse than one that does not.
  return Math.ceil(input + output);
}

export interface BudgetState {
  spentMicros: number;
  limitMicros: number;
}

export type BudgetDecision =
  | { allowed: true; remainingMicros: number }
  | { allowed: false; reason: string };

/**
 * Whether another call is within budget.
 *
 * A daily cap exists because an AI feature with no ceiling is an unbounded
 * liability attached to a text box: a loop, a retry storm or a careless script
 * can spend a very large amount of somebody else's money before anyone notices.
 * The cap is checked *before* the call, not reconciled after.
 */
export function checkBudget(state: BudgetState, estimatedMicros: number): BudgetDecision {
  if (state.limitMicros <= 0) {
    return { allowed: false, reason: 'No AI budget is configured.' };
  }
  if (state.spentMicros >= state.limitMicros) {
    return { allowed: false, reason: 'The AI budget for today has been used up.' };
  }
  if (state.spentMicros + estimatedMicros > state.limitMicros) {
    return { allowed: false, reason: 'This request would exceed the AI budget for today.' };
  }
  return { allowed: true, remainingMicros: state.limitMicros - state.spentMicros };
}

/** A rough token estimate, for budgeting before a call. */
export function estimateTokens(text: string): number {
  // Four characters per token is the usual rule of thumb. Deliberately rounded
  // up: an estimate that under-shoots lets a call through that the budget
  // should have stopped.
  return Math.ceil(text.length / 4) + 1;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export const AI_OUTCOMES = [
  'COMPLETED',
  /** The guardrails refused the output. Recorded with the findings. */
  'BLOCKED',
  /** Retrieval was empty, so no model was called. */
  'NO_GROUNDING',
  /** The budget or a rate limit refused it before the call. */
  'REFUSED',
  /** The provider failed. */
  'FAILED',
] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

/**
 * The sentence shown when there is nothing approved to answer from.
 *
 * Said plainly, and not softened. "I could not find approved information about
 * that" is useful; a fluent guess is worse than silence, and on a health
 * product it is the specific failure that causes harm.
 */
export const NO_GROUNDING_MESSAGE =
  'There is no approved, recorded information in this system that answers that. Nothing has been generated, because a plausible answer with no basis is worse than no answer.';
