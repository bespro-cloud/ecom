import { describe, expect, it } from 'vitest';
import {
  DUNNING_SCHEDULE_DAYS,
  REVIEW_STATUSES,
  REVIEW_STATUS_TRANSITIONS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_TRANSITIONS,
  adverseEventPromptTerms,
  canTransitionReview,
  canTransitionSubscription,
  healthClaimPromptTerms,
  isReviewVisible,
  nextDunningAttemptAt,
  nextPeriodStart,
  percentageDiscountCents,
  subscriptionMayBill,
  subscriptionMayShip,
} from './lifecycle.js';

describe('review moderation', () => {
  it('makes published the only visible state', () => {
    expect(REVIEW_STATUSES.filter(isReviewVisible)).toEqual(['PUBLISHED']);
  });

  it('has no route to visibility that skips a moderator', () => {
    // Every edge into PUBLISHED comes from a state a person had to act on.
    // There is no timer, no score and no default that publishes.
    const publishing = REVIEW_STATUSES.filter((from) => canTransitionReview(from, 'PUBLISHED'));
    expect(publishing.sort()).toEqual(['ESCALATED', 'PENDING']);
  });

  it('does not let an escalated review go back to pending', () => {
    // Escalation hands the decision to compliance. A moderator who escalated
    // must not be able to quietly take it back and publish it as routine.
    expect(canTransitionReview('ESCALATED', 'PENDING')).toBe(false);
  });

  it('makes rejection and withdrawal terminal', () => {
    expect(REVIEW_STATUS_TRANSITIONS.REJECTED).toEqual([]);
    expect(REVIEW_STATUS_TRANSITIONS.WITHDRAWN).toEqual([]);
  });

  it('names every status in the transition table', () => {
    for (const status of REVIEW_STATUSES) {
      expect(REVIEW_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe('the health-claim prompt', () => {
  it('flags wording a moderator needs to look at', () => {
    expect(healthClaimPromptTerms('This cured my insomnia')).toContain('cured');
    expect(healthClaimPromptTerms('helps prevent colds')).toContain('prevent');
  });

  it('does not fire on a word that merely contains a term', () => {
    // "manicure" contains "cure". A prompt that cried wolf on ordinary prose
    // would train moderators to dismiss the banner, which is worse than not
    // having one.
    expect(healthClaimPromptTerms('I had a manicure')).toEqual([]);
    expect(healthClaimPromptTerms('obscured the label')).toEqual([]);
  });

  it('is case-insensitive, because customers do not write carefully', () => {
    expect(healthClaimPromptTerms('CURED my headache')).toContain('cured');
  });

  it('separates possible adverse events from claims', () => {
    // Different action: an adverse event is a safety signal that must reach
    // someone whether or not the review is ever published.
    expect(adverseEventPromptTerms('I had an allergic reaction')).toContain('allergic reaction');
  });

  it('returns the terms, not a verdict', () => {
    // The type is what keeps this a prompt. A boolean would invite a caller to
    // branch on it and make a regulatory judgement by substring match.
    expect(Array.isArray(healthClaimPromptTerms('cure'))).toBe(true);
  });
});

describe('percentage discounts', () => {
  it('rounds down, never up', () => {
    // 33.33% of 1000 is 333.3. Rounding up hands out money the coupon did not
    // promise, every time, on every order.
    expect(percentageDiscountCents(1000, 3333)).toBe(333);
  });

  it('gives nothing away at zero and everything at full', () => {
    expect(percentageDiscountCents(2500, 0)).toBe(0);
    expect(percentageDiscountCents(2500, 10_000)).toBe(2500);
  });

  it('refuses a rate above 100 per cent', () => {
    expect(() => percentageDiscountCents(1000, 10_001)).toThrow(/between 0 and 10000/);
  });

  it('refuses a fractional subtotal', () => {
    expect(() => percentageDiscountCents(10.5, 1000)).toThrow(/integer of cents/);
  });
});

describe('subscription states', () => {
  it('ships only while active', () => {
    expect(SUBSCRIPTION_STATUSES.filter(subscriptionMayShip)).toEqual(['ACTIVE']);
  });

  it('does not ship while a renewal is failing', () => {
    // The whole point of PAST_DUE: keep trying to collect, stop sending goods.
    expect(subscriptionMayBill('PAST_DUE')).toBe(true);
    expect(subscriptionMayShip('PAST_DUE')).toBe(false);
  });

  it('never bills a paused or cancelled subscription', () => {
    expect(subscriptionMayBill('PAUSED')).toBe(false);
    expect(subscriptionMayBill('CANCELLED')).toBe(false);
    expect(subscriptionMayBill('PENDING')).toBe(false);
  });

  it('makes cancellation terminal', () => {
    expect(SUBSCRIPTION_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(canTransitionSubscription('CANCELLED', status)).toBe(false);
    }
  });

  it('lets a recovered payment reactivate an unpaid subscription', () => {
    expect(canTransitionSubscription('UNPAID', 'ACTIVE')).toBe(true);
  });
});

describe('dunning', () => {
  it('is bounded', () => {
    const start = new Date('2026-03-01T00:00:00Z');
    expect(nextDunningAttemptAt(start, DUNNING_SCHEDULE_DAYS.length)).toBeNull();
  });

  it('waits longer between each attempt', () => {
    const start = new Date('2026-03-01T00:00:00Z');
    const gaps = DUNNING_SCHEDULE_DAYS.map((_, index) => {
      const at = nextDunningAttemptAt(start, index)!;
      return at.getTime() - start.getTime();
    });
    for (let index = 1; index < gaps.length; index += 1) {
      expect(gaps[index]!).toBeGreaterThan(gaps[index - 1]!);
    }
  });
});

describe('the next billing date', () => {
  it('keeps the day of the month', () => {
    const next = nextPeriodStart(new Date('2026-03-15T09:00:00Z'), 'MONTH', 1);
    expect(next.toISOString()).toBe('2026-04-15T09:00:00.000Z');
  });

  it('clamps rather than spilling into the next month', () => {
    // The 31st of January plus one month is not the 3rd of March. A naive date
    // constructor produces exactly that, and the customer is charged early.
    const next = nextPeriodStart(new Date('2026-01-31T09:00:00Z'), 'MONTH', 1);
    expect(next.toISOString()).toBe('2026-02-28T09:00:00.000Z');
  });

  it('returns to the anchor day after a short month', () => {
    // Having been clamped to the 28th in February, the subscription goes back
    // to the 31st — it does not stay on the 28th forever.
    const next = nextPeriodStart(new Date('2026-02-28T09:00:00Z'), 'MONTH', 1, 31);
    expect(next.toISOString()).toBe('2026-03-31T09:00:00.000Z');
  });

  it('handles a leap year', () => {
    const next = nextPeriodStart(new Date('2028-01-31T09:00:00Z'), 'MONTH', 1);
    expect(next.toISOString()).toBe('2028-02-29T09:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    const next = nextPeriodStart(new Date('2026-12-15T09:00:00Z'), 'MONTH', 1);
    expect(next.toISOString()).toBe('2027-01-15T09:00:00.000Z');
  });

  it('adds whole weeks without touching the clock time', () => {
    const next = nextPeriodStart(new Date('2026-03-15T09:00:00Z'), 'WEEK', 2);
    expect(next.toISOString()).toBe('2026-03-29T09:00:00.000Z');
  });

  it('refuses a non-positive interval', () => {
    expect(() => nextPeriodStart(new Date(), 'MONTH', 0)).toThrow(/positive whole number/);
  });
});
