import { describe, expect, it } from 'vitest';
import {
  AI_PURPOSES,
  AI_SUGGESTION_KINDS,
  checkBudget,
  checkGrounding,
  computeCostMicros,
  estimateTokens,
  isCustomerFacing,
  redactForModel,
  requiresRetrieval,
  scanGeneratedText,
  suggestionKindFor,
  verifyCitations,
  wasRedacted,
  NO_GROUNDING_MESSAGE,
  PROHIBITED_OF_AI,
} from './ai.js';

/**
 * These tests are almost entirely about refusals.
 *
 * The useful behaviour of an AI feature is easy to check by using it. The
 * behaviour worth protecting with tests is what it will not do — because those
 * are the paths nobody exercises by hand, and the ones where the failure is a
 * fluent paragraph rather than an error.
 */

describe('what AI may be asked for', () => {
  it('has no purpose that decides anything', () => {
    // The allow-list is the enforcement. If a purpose for approving a claim
    // existed, everything downstream would be arguing about whether to use it.
    const decisionWords = /approve|reject|publish|refund|moderate|erase|grant|adjust/i;
    for (const purpose of AI_PURPOSES) {
      expect(purpose).not.toMatch(decisionWords);
    }
  });

  it('has no suggestion kind that could complete a sensitive action', () => {
    // Applying a suggestion writes descriptive text to a draft. There is no
    // enum member that could express anything else.
    const forbidden = /claim|compliance|publish|refund|inventory|recall|erasure|permission|role/i;
    for (const kind of AI_SUGGESTION_KINDS) {
      expect(kind).not.toMatch(forbidden);
    }
  });

  it('keeps the prohibited list non-empty and specific', () => {
    // Documentation with teeth: if somebody adds a purpose for one of these,
    // the two tests above start failing.
    expect(PROHIBITED_OF_AI.length).toBeGreaterThan(8);
    expect(PROHIBITED_OF_AI).toContain('approve or reject a product claim');
    expect(PROHIBITED_OF_AI).toContain('answer a customer question about their own health');
  });

  it('maps every purpose to a suggestion kind', () => {
    for (const purpose of AI_PURPOSES) {
      expect(AI_SUGGESTION_KINDS).toContain(suggestionKindFor(purpose));
    }
  });

  it('grounds the purposes that answer questions', () => {
    expect(requiresRetrieval('KNOWLEDGE_ANSWER')).toBe(true);
    expect(requiresRetrieval('EVIDENCE_DIGEST')).toBe(true);
    // These are grounded by their input rather than by retrieval: a summary is
    // given the numbers, a support draft is given the conversation.
    expect(requiresRetrieval('ANALYTICS_SUMMARY')).toBe(false);
    expect(requiresRetrieval('SUPPORT_REPLY_DRAFT')).toBe(false);
  });

  it('knows which output a customer will read', () => {
    expect(isCustomerFacing('PRODUCT_COPY_DRAFT')).toBe(true);
    expect(isCustomerFacing('SEO_METADATA_DRAFT')).toBe(true);
    expect(isCustomerFacing('EVIDENCE_DIGEST')).toBe(false);
  });
});

describe('guardrails on generated copy', () => {
  const blocked = (text: string) => scanGeneratedText(text, 'PRODUCT_COPY_DRAFT');

  it('blocks a disease claim', () => {
    const verdict = blocked('This magnesium supplement cures insomnia and prevents anxiety.');
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((finding) => finding.code)).toContain('disease_claim');
  });

  it('blocks a named disease even in otherwise careful wording', () => {
    const verdict = blocked('Some research has looked at magnesium in people with diabetes.');
    expect(verdict.allowed).toBe(false);
  });

  it('blocks an FDA assertion', () => {
    expect(blocked('Our FDA approved formula is the best available.').allowed).toBe(false);
    expect(blocked('This is clinically proven to work.').allowed).toBe(false);
  });

  it('blocks dosing instructions', () => {
    expect(blocked('Take 400mg daily for best results.').allowed).toBe(false);
    expect(blocked('You can stop taking your usual supplement.').allowed).toBe(false);
  });

  it('blocks an absolute guarantee', () => {
    expect(blocked('Guaranteed results with no side effects.').allowed).toBe(false);
    expect(blocked('This is 100% safe for everyone.').allowed).toBe(false);
  });

  it('blocks an invented certification', () => {
    // These are facts recorded in the documents table, as stated by an
    // uploader. A model asserting one in prose is inventing a manufacturing
    // fact, which is the same category of error as inventing evidence.
    expect(blocked('Every batch is third-party tested in a GMP certified facility.').allowed).toBe(
      false,
    );
  });

  it('allows ordinary descriptive copy', () => {
    const verdict = blocked(
      'A magnesium glycinate supplement in a vegetarian capsule. Each bottle contains 120 capsules. Made in the United States.',
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it('flags rather than blocks the same words in an internal digest', () => {
    // A reviewer reading a summary of a paper needs the sentence "the study
    // reported reduced anxiety scores". The same words on a product page are a
    // regulatory problem; in a digest they are the content.
    const verdict = scanGeneratedText(
      'The trial measured sleep latency in adults and reported no change in depression scores.',
      'EVIDENCE_DIGEST',
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.findings.length).toBeGreaterThan(0);
    expect(verdict.findings.every((finding) => finding.severity === 'flag')).toBe(true);
  });

  it('blocks advice to an individual even in an internal note', () => {
    // Internal notes get pasted into replies. "You should take" is not made
    // acceptable by the window it was written in.
    const verdict = scanGeneratedText(
      'You should take two capsules for your condition.',
      'EVIDENCE_DIGEST',
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((finding) => finding.code)).toContain('clinical_advice');
  });

  it('blocks a regulatory assertion even internally', () => {
    // "FDA approved" is false wherever it is written, and an internal note is
    // one copy-paste from a listing.
    expect(scanGeneratedText('The FDA approved this in 2019.', 'EVIDENCE_DIGEST').allowed).toBe(
      false,
    );
  });

  it('reports what tripped it, so a person can see why', () => {
    const verdict = blocked('This product cures everything.');
    expect(verdict.findings[0]!.evidence).toMatch(/cures/i);
    expect(verdict.findings[0]!.message.length).toBeGreaterThan(20);
  });
});

describe('citations', () => {
  it('separates real citations from invented ones', () => {
    // Models invent references in exactly the right format, with plausible
    // identifiers. That is what makes the failure dangerous and why this check
    // is mechanical rather than a spot check.
    const result = verifyCitations(
      'Magnesium is a mineral [[ev-1]]. A study found something [[ev-99]].',
      ['ev-1', 'ev-2'],
    );
    expect(result.cited).toEqual(['ev-1']);
    expect(result.fabricated).toEqual(['ev-99']);
  });

  it('blocks an answer citing a source that was never retrieved', () => {
    const findings = checkGrounding('As shown in [[made-up]].', ['real-1']);
    expect(findings.some((finding) => finding.code === 'fabricated_citation')).toBe(true);
    expect(findings.every((finding) => finding.severity === 'block')).toBe(true);
  });

  it('blocks an answer that cites nothing at all', () => {
    // For a grounded purpose an uncited sentence is the model speaking from
    // memory, which is the thing retrieval exists to prevent.
    const findings = checkGrounding('Magnesium helps with sleep.', ['real-1']);
    expect(findings.some((finding) => finding.code === 'ungrounded_answer')).toBe(true);
  });

  it('accepts a properly cited answer', () => {
    expect(checkGrounding('Magnesium is a mineral [[real-1]].', ['real-1', 'real-2'])).toEqual([]);
  });

  it('ignores ordinary bracket usage in prose', () => {
    const result = verifyCitations('An aside [like this] and a list [1] [2].', ['a']);
    expect(result.cited).toEqual([]);
    expect(result.fabricated).toEqual([]);
  });
});

describe('redaction before anything leaves for a provider', () => {
  it('removes an email address', () => {
    const redacted = redactForModel('Ada wrote in from ada.lovelace@example.test about her order.');
    expect(redacted).not.toContain('ada.lovelace@example.test');
    expect(redacted).toContain('[email]');
  });

  it('removes a card-shaped number', () => {
    expect(redactForModel('The card 4111 1111 1111 1111 was declined.')).not.toContain('4111');
  });

  it('removes a phone number', () => {
    expect(redactForModel('Call them on +1 801 555 0199 tomorrow.')).not.toContain('555 0199');
  });

  it('removes an order reference', () => {
    expect(redactForModel('Order HC-2026-A1B2C3 has not arrived.')).not.toContain('HC-2026-A1B2C3');
  });

  it('removes a street address', () => {
    expect(redactForModel('Deliver to 1 Innovation Way, Salt Lake City.')).toContain('[address]');
  });

  it('removes a long opaque token', () => {
    const token = 'a'.repeat(40);
    expect(redactForModel(`Session ${token} expired.`)).not.toContain(token);
  });

  it('leaves ordinary product text alone', () => {
    const text = 'The customer asked whether the capsules are vegetarian.';
    expect(redactForModel(text)).toBe(text);
    expect(wasRedacted(text, redactForModel(text))).toBe(false);
  });

  it('reports that redaction happened, for the audit record', () => {
    const original = 'Contact ada@example.test';
    expect(wasRedacted(original, redactForModel(original))).toBe(true);
  });
});

describe('cost and budget', () => {
  it('computes cost in hundredths of a cent and rounds up', () => {
    // Rounding up because a cost report that under-states is worse than one
    // that does not.
    const cost = computeCostMicros(
      { inputTokens: 1000, outputTokens: 500 },
      { inputPerMillionMicros: 300_000, outputPerMillionMicros: 1_500_000 },
    );
    expect(cost).toBe(Math.ceil((1000 * 300_000) / 1_000_000 + (500 * 1_500_000) / 1_000_000));
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('refuses a call that would exceed the day’s budget', () => {
    // Checked before the call, not reconciled after. An AI feature with no
    // ceiling is an unbounded liability attached to a text box.
    expect(checkBudget({ spentMicros: 900, limitMicros: 1000 }, 200)).toEqual({
      allowed: false,
      reason: 'This request would exceed the AI budget for today.',
    });
  });

  it('refuses everything when no budget is configured', () => {
    // Zero means off, not unlimited. An unset limit must fail closed.
    expect(checkBudget({ spentMicros: 0, limitMicros: 0 }, 1).allowed).toBe(false);
  });

  it('allows a call inside the budget and reports what is left', () => {
    expect(checkBudget({ spentMicros: 100, limitMicros: 1000 }, 200)).toEqual({
      allowed: true,
      remainingMicros: 900,
    });
  });

  it('estimates tokens on the high side', () => {
    // An estimate that under-shoots lets a call through the budget should have
    // stopped.
    expect(estimateTokens('abcd')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThanOrEqual(100);
  });
});

describe('having nothing to say', () => {
  it('says so plainly', () => {
    expect(NO_GROUNDING_MESSAGE).toMatch(/no approved/i);
    expect(NO_GROUNDING_MESSAGE).toMatch(/worse than no answer/i);
  });
});
