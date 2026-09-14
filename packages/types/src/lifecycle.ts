/**
 * The customer lifecycle: reviews, coupons, subscriptions, support and
 * account self-service.
 *
 * Three concerns run through all of it, and each one is the reason a piece of
 * this is shaped the way it is rather than the obvious way.
 *
 * **Customer speech about a regulated product is still speech about a regulated
 * product.** A review saying "cured my insomnia" is an unapproved disease claim
 * on the listing, and the fact that a customer wrote it rather than the
 * marketing team does not change what a regulator sees. Reviews are therefore
 * moderated before they are visible, and a moderator can escalate rather than
 * having to choose between publishing and rejecting.
 *
 * **Recurring money is money.** A renewal is a charge, so it carries the same
 * requirements as a checkout: idempotency per period, provider tokens rather
 * than card data, bounded retries, and a failure that stops fulfilment rather
 * than shipping on hope.
 *
 * **Deletion is a request, not a switch.** A customer can ask to be erased. The
 * business cannot comply by destroying order history it is legally required to
 * keep, so the request is recorded, reviewed by a person, and satisfied by
 * removing what can be removed — not by a cascade.
 */

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const REVIEW_STATUSES = [
  /** Written, not yet looked at. Never visible. */
  'PENDING',
  /** A moderator published it. The only visible state. */
  'PUBLISHED',
  'REJECTED',
  /**
   * A moderator thought it might make a health claim and passed it to
   * compliance. Not visible, and not a moderator's decision any more.
   */
  'ESCALATED',
  /** Taken down after publication. */
  'WITHDRAWN',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * The review lifecycle.
 *
 * Note that `PENDING → PUBLISHED` is the only route to visibility, and that
 * there is no automatic transition into it. Nothing in this system publishes a
 * review because it looks harmless, scored well, or aged past a timer.
 */
export const REVIEW_STATUS_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  PENDING: ['PUBLISHED', 'REJECTED', 'ESCALATED'],
  // Escalation is one-way into compliance: a moderator who escalated cannot
  // then publish it themselves.
  ESCALATED: ['PUBLISHED', 'REJECTED'],
  PUBLISHED: ['WITHDRAWN'],
  REJECTED: [],
  WITHDRAWN: [],
};

export function canTransitionReview(from: ReviewStatus, to: ReviewStatus): boolean {
  return REVIEW_STATUS_TRANSITIONS[from].includes(to);
}

/** The one state in which a review appears on a listing. */
export function isReviewVisible(status: ReviewStatus): boolean {
  return status === 'PUBLISHED';
}

export const REVIEW_REJECTION_REASONS = [
  'OFF_TOPIC',
  'ABUSIVE',
  'SPAM',
  'PERSONAL_INFORMATION',
  /** Reads as a claim about treating or preventing a disease. */
  'HEALTH_CLAIM',
  'ADVERSE_EVENT',
  'OTHER',
] as const;
export type ReviewRejectionReason = (typeof REVIEW_REJECTION_REASONS)[number];

export const MIN_RATING = 1;
export const MAX_RATING = 5;

/**
 * Phrases that make a review worth a second pair of eyes.
 *
 * **This is a prompt for a human, never a decision.** Nothing is auto-rejected
 * or auto-published on the strength of it: every review is read by a moderator
 * regardless, and this only decides whether the moderation screen puts a
 * "check this for a health claim" banner at the top. A list of words cannot
 * tell whether "it cured my headache" is a disease claim in context, and a
 * system that acted on one would be making a regulatory judgement by substring
 * match.
 *
 * Deliberately over-inclusive. A false prompt costs a moderator two seconds; a
 * missed one puts a disease claim on a supplement listing.
 */
export const HEALTH_CLAIM_PROMPT_TERMS: readonly string[] = [
  'cure',
  'cured',
  'cures',
  'heal',
  'healed',
  'treat',
  'treated',
  'treatment',
  'prevent',
  'prevents',
  'prevented',
  'diagnose',
  'remission',
  'tumour',
  'tumor',
  'cancer',
  'diabetes',
  'depression',
  'anxiety disorder',
  'arthritis',
  'infection',
  'covid',
  'blood pressure',
  'cholesterol',
  'prescription',
  'medication',
  'doctor told me',
  'instead of my',
  'stopped taking',
  'side effect',
  'allergic reaction',
  'hospital',
  'emergency',
];

/**
 * Which prompt terms a review contains, for the moderator's banner.
 *
 * Returns the matches rather than a boolean so the screen can say *what* to
 * look at. Word-boundary matched so "prevention" does not hide inside
 * "preventative" unnoticed and "cure" does not fire on "manicure".
 */
export function healthClaimPromptTerms(text: string): string[] {
  const haystack = text.toLowerCase();
  return HEALTH_CLAIM_PROMPT_TERMS.filter((term) => {
    const index = haystack.indexOf(term);
    if (index === -1) return false;
    const before = index === 0 ? ' ' : haystack[index - 1]!;
    const after = haystack[index + term.length] ?? ' ';
    return !/[a-z]/.test(before) && !/[a-z]/.test(after);
  });
}

/**
 * Terms that suggest the customer is describing harm they experienced.
 *
 * Separate from the claim list because the action is different: a possible
 * adverse event is a safety signal the business may have a duty to record and
 * report, and it must reach someone regardless of whether the review is ever
 * published.
 */
export const ADVERSE_EVENT_PROMPT_TERMS: readonly string[] = [
  'side effect',
  'allergic reaction',
  'rash',
  'hives',
  'vomit',
  'vomited',
  'nausea',
  'hospital',
  'emergency',
  'poisoned',
  'poisoning',
  'reaction',
  'seizure',
  'fainted',
];

export function adverseEventPromptTerms(text: string): string[] {
  const haystack = text.toLowerCase();
  return ADVERSE_EVENT_PROMPT_TERMS.filter((term) => haystack.includes(term));
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

export const COUPON_TYPES = [
  /** A fixed number of minor units off the basket. */
  'FIXED_AMOUNT',
  /** A percentage of the eligible subtotal, in basis points. */
  'PERCENTAGE',
  /** Shipping reduced to zero. Never touches the goods total. */
  'FREE_SHIPPING',
] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const COUPON_REJECTIONS = [
  'NOT_FOUND',
  'INACTIVE',
  'NOT_STARTED',
  'EXPIRED',
  'USAGE_LIMIT_REACHED',
  'CUSTOMER_LIMIT_REACHED',
  'MINIMUM_NOT_MET',
  'NOT_ELIGIBLE',
  'CUSTOMER_REQUIRED',
  'ALREADY_APPLIED',
] as const;
export type CouponRejection = (typeof COUPON_REJECTIONS)[number];

/**
 * Why a coupon was refused, in words a customer can act on.
 *
 * `NOT_FOUND` and `INACTIVE` deliberately give the same message. Distinguishing
 * them turns the checkout into an oracle for enumerating valid codes, and
 * "this code is real but switched off" is not information a customer can use
 * anyway.
 */
export const COUPON_REJECTION_MESSAGES: Record<CouponRejection, string> = {
  NOT_FOUND: 'That code is not valid.',
  INACTIVE: 'That code is not valid.',
  NOT_STARTED: 'That code is not active yet.',
  EXPIRED: 'That code has expired.',
  USAGE_LIMIT_REACHED: 'That code has been fully redeemed.',
  CUSTOMER_LIMIT_REACHED: 'You have already used that code.',
  MINIMUM_NOT_MET: 'Your basket does not meet the minimum for that code.',
  NOT_ELIGIBLE: 'That code does not apply to anything in your basket.',
  CUSTOMER_REQUIRED: 'Sign in to use that code.',
  ALREADY_APPLIED: 'That code is already applied.',
};

/** Basis points, so a percentage is an integer and never a float. */
export const BASIS_POINTS = 10_000;

/**
 * The value of a percentage coupon against an eligible subtotal.
 *
 * Integer arithmetic throughout, rounded down: rounding a discount *up* hands
 * out money the coupon did not promise, and across enough orders that is a real
 * number.
 */
export function percentageDiscountCents(eligibleCents: number, basisPoints: number): number {
  if (!Number.isInteger(eligibleCents) || eligibleCents < 0) {
    throw new Error('Eligible subtotal must be a non-negative integer of cents.');
  }
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > BASIS_POINTS) {
    throw new Error('A percentage must be between 0 and 10000 basis points.');
  }
  return Math.floor((eligibleCents * basisPoints) / BASIS_POINTS);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_INTERVALS = ['WEEK', 'MONTH'] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];

export const SUBSCRIPTION_STATUSES = [
  /** Created but the first payment has not settled. Nothing ships. */
  'PENDING',
  'ACTIVE',
  /** Customer paused it. No charges, no shipments, resumable. */
  'PAUSED',
  /** A renewal failed and is being retried. Nothing ships meanwhile. */
  'PAST_DUE',
  /** Retries exhausted. Terminal without customer action. */
  'UNPAID',
  'CANCELLED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_TRANSITIONS: Record<
  SubscriptionStatus,
  readonly SubscriptionStatus[]
> = {
  PENDING: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'PAST_DUE', 'CANCELLED'],
  PAUSED: ['ACTIVE', 'CANCELLED'],
  PAST_DUE: ['ACTIVE', 'UNPAID', 'CANCELLED'],
  UNPAID: ['ACTIVE', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransitionSubscription(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return SUBSCRIPTION_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Whether a subscription in this state may have goods dispatched against it.
 *
 * An allow-list of exactly one state, for the same reason lot allocation uses
 * one: a status added later is not shippable until somebody deliberately says
 * so. A block-list would make every new status silently ship.
 */
export function subscriptionMayShip(status: SubscriptionStatus): boolean {
  return status === 'ACTIVE';
}

/** Whether a billing run should attempt a charge for this subscription. */
export function subscriptionMayBill(status: SubscriptionStatus): boolean {
  return status === 'ACTIVE' || status === 'PAST_DUE';
}

/**
 * How many times a failed renewal is retried before the subscription is left
 * unpaid, and how long to wait between attempts.
 *
 * Bounded and increasing. Retrying a declined card every hour forever is how a
 * customer's bank starts treating the business as a problem, and it is not a
 * kindness to the customer either.
 */
export const DUNNING_SCHEDULE_DAYS: readonly number[] = [1, 3, 5];

export function nextDunningAttemptAt(from: Date, attempt: number): Date | null {
  const days = DUNNING_SCHEDULE_DAYS[attempt];
  if (days === undefined) return null;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The next billing date after a period ends.
 *
 * Anchored to the day-of-month of the original start so a subscription started
 * on the 15th stays on the 15th, and clamped when the target month is shorter —
 * the 31st becomes the 30th in November rather than silently landing in
 * December. Computed in UTC: a renewal date that shifts with daylight saving
 * charges some customers a day early twice a year.
 */
export function nextPeriodStart(
  current: Date,
  interval: SubscriptionInterval,
  intervalCount: number,
  anchorDayOfMonth?: number,
): Date {
  if (!Number.isInteger(intervalCount) || intervalCount < 1) {
    throw new Error('Interval count must be a positive whole number.');
  }

  if (interval === 'WEEK') {
    return new Date(current.getTime() + intervalCount * 7 * 24 * 60 * 60 * 1000);
  }

  const year = current.getUTCFullYear();
  const month = current.getUTCMonth() + intervalCount;
  const anchor = anchorDayOfMonth ?? current.getUTCDate();

  // Day 0 of the following month is the last day of the target month.
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchor, daysInTarget);

  return new Date(
    Date.UTC(
      year,
      month,
      day,
      current.getUTCHours(),
      current.getUTCMinutes(),
      current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    ),
  );
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export const SUPPORT_STATUSES = ['OPEN', 'AWAITING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_TOPICS = [
  'ORDER',
  'DELIVERY',
  'RETURN_OR_REFUND',
  'PRODUCT_QUESTION',
  'SUBSCRIPTION',
  'ACCOUNT',
  'OTHER',
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

/**
 * Topics a customer cannot raise here.
 *
 * There is deliberately no "medical question" topic. This platform does not
 * offer clinical advice, has no mechanism for a qualified person to give it,
 * and a support inbox that invited the question would collect health
 * information the business has no lawful basis to hold and no ability to act
 * on. The storefront says so at the point of asking rather than after.
 */
export const SUPPORT_MEDICAL_REDIRECT =
  'We cannot answer questions about your health, medication or symptoms, and please do not share those details with us. Speak to your doctor or pharmacist. If this is an emergency, contact your local emergency services.';

// ---------------------------------------------------------------------------
// Account erasure
// ---------------------------------------------------------------------------

export const ERASURE_STATUSES = ['REQUESTED', 'IN_REVIEW', 'COMPLETED', 'REFUSED'] as const;
export type ErasureStatus = (typeof ERASURE_STATUSES)[number];

/**
 * What an erasure request can and cannot remove.
 *
 * Under both GDPR Article 17(3) and US record-keeping rules, the right to
 * erasure yields to a legal obligation to retain. Orders, payments, refunds,
 * compliance decisions and recall records are all retained regardless — so the
 * honest thing is to say which is which up front, rather than promising
 * deletion and quietly keeping the rows.
 */
export const ERASABLE_DATA = [
  'Marketing preferences and contact details',
  'Saved addresses',
  'Saved payment methods (the provider token, not the card — we never had that)',
  'Support conversations',
  'Reviews you wrote, and your name against them',
  'Your account sign-in',
] as const;

export const RETAINED_DATA = [
  'Orders, payments and refunds — required for tax, accounting and consumer-protection records',
  'Which lots you received — required so you can be contacted about a product recall',
  'Consent history — the evidence that you agreed to what you agreed to',
  'Audit records of actions taken on your account',
] as const;
