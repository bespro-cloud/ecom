import { z } from 'zod';
import {
  COUPON_TYPES,
  ERASURE_STATUSES,
  MAX_RATING,
  MIN_RATING,
  REVIEW_REJECTION_REASONS,
  REVIEW_STATUSES,
  SUBSCRIPTION_INTERVALS,
  SUBSCRIPTION_STATUSES,
  SUPPORT_STATUSES,
  SUPPORT_TOPICS,
} from '@health/types';
import { paginationSchema, uuidSchema } from './primitives.js';
import { moneyCentsSchema } from './catalogue.js';
import { quantitySchema } from './commerce.js';

/**
 * Customer-lifecycle request validation.
 *
 * The rule from Phase 3 still holds and matters more here, not less: **no
 * request may name a price or a discount.** A coupon request carries a code and
 * nothing else; what it is worth is looked up and computed server-side. A
 * subscription request carries variants and quantities; the amounts come from
 * the agreement already recorded against it.
 *
 * The second rule is new to this phase: **nothing a customer writes is
 * published by the act of writing it.** A review has no status field, because a
 * client that could set one could publish an unreviewed health claim onto a
 * listing.
 */

const notes = (min: number, message: string) => z.string().trim().min(min, message).max(2000);

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * Writing a review.
 *
 * There is deliberately no `status`, no `verifiedPurchase` and no
 * `publishedAt`. Status is a moderator's decision; the verified badge is
 * derived from a real order line the server looks up. A field for either would
 * be a field a client could use to put unreviewed text on a product page.
 */
export const createReviewSchema = z.object({
  productId: uuidSchema,
  /**
   * The purchase being reviewed. Checked server-side against the caller's own
   * orders; supplying someone else's changes nothing except getting refused.
   */
  orderItemId: uuidSchema.optional(),
  rating: z
    .number()
    .int('Give a whole number of stars.')
    .min(MIN_RATING, `Ratings run from ${MIN_RATING} to ${MAX_RATING}.`)
    .max(MAX_RATING, `Ratings run from ${MIN_RATING} to ${MAX_RATING}.`),
  title: z.string().trim().max(120).optional(),
  body: z
    .string()
    .trim()
    .min(10, 'Tell other customers a little about what you thought.')
    .max(4000),
  /** Shown publicly. Defaulted to a first name by the client, never to an email. */
  authorDisplayName: z
    .string()
    .trim()
    .min(2, 'Choose a name to show with your review.')
    .max(60)
    .refine((value) => !value.includes('@'), {
      message: 'Please use a name rather than an email address — this is shown publicly.',
    }),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

/**
 * A moderator's decision.
 *
 * Notes are required on every outcome, including publication. "Why is this
 * live?" is as worth answering as "why was this rejected?", and on a health
 * product it is the more important of the two.
 */
export const moderateReviewSchema = z
  .object({
    decision: z.enum(['PUBLISHED', 'REJECTED', 'ESCALATED', 'WITHDRAWN']),
    reason: z.enum(REVIEW_REJECTION_REASONS).optional(),
    notes: notes(10, 'Record why you reached this decision.'),
    /**
     * Set when the review describes harm the customer experienced. Recorded
     * whether or not the review is published, because a safety signal does not
     * stop mattering when the text is rejected.
     */
    flagAdverseEvent: z.boolean().default(false),
  })
  .refine((value) => value.decision !== 'REJECTED' || value.reason !== undefined, {
    message: 'Say why the review is being rejected.',
    path: ['reason'],
  });
export type ModerateReviewInput = z.infer<typeof moderateReviewSchema>;

export const reviewQuerySchema = paginationSchema.extend({
  productId: uuidSchema.optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  /** Only reviews whose wording prompted a health-claim check. */
  promptedOnly: z.coerce.boolean().optional(),
});
export type ReviewQuery = z.infer<typeof reviewQuerySchema>;

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

/**
 * A coupon code as a customer types it.
 *
 * Uppercased and trimmed, because the code on the card is uppercase and nobody
 * types it that way. Matched case-insensitively in the database too.
 */
export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, 'Enter the code exactly as it appears.')
  .max(40)
  .regex(/^[A-Z0-9_-]+$/, 'Codes contain letters, numbers, hyphens and underscores.');

/** Applying a code at checkout. The code is the entire input. */
export const applyCouponSchema = z.object({ code: couponCodeSchema });
export type ApplyCouponInput = z.infer<typeof applyCouponSchema>;

export const createCouponSchema = z
  .object({
    code: couponCodeSchema,
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).optional(),
    type: z.enum(COUPON_TYPES),
    amountCents: moneyCentsSchema.positive('A fixed discount must be more than zero.').optional(),
    basisPoints: z
      .number()
      .int('A percentage is expressed in basis points.')
      .min(1)
      .max(10_000, '100% is the most a coupon can take off.')
      .optional(),
    minSubtotalCents: moneyCentsSchema.optional(),
    maxDiscountCents: moneyCentsSchema.positive().optional(),
    maxRedemptions: z.number().int().min(1).max(10_000_000).optional(),
    maxPerCustomer: z.number().int().min(1).max(1000).optional(),
    eligibleProductIds: z.array(uuidSchema).max(500).default([]),
    eligibleCategoryIds: z.array(uuidSchema).max(100).default([]),
    requiresCustomer: z.boolean().default(false),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    isActive: z.boolean().default(true),
  })
  .refine(
    (value) =>
      value.type !== 'FIXED_AMOUNT' ||
      (value.amountCents !== undefined && value.basisPoints === undefined),
    { message: 'A fixed-amount coupon needs an amount and no percentage.', path: ['amountCents'] },
  )
  .refine(
    (value) =>
      value.type !== 'PERCENTAGE' ||
      (value.basisPoints !== undefined && value.amountCents === undefined),
    { message: 'A percentage coupon needs a percentage and no amount.', path: ['basisPoints'] },
  )
  .refine(
    (value) =>
      value.type !== 'FREE_SHIPPING' ||
      (value.amountCents === undefined && value.basisPoints === undefined),
    { message: 'A free-shipping coupon takes neither an amount nor a percentage.', path: ['type'] },
  )
  .refine(
    (value) =>
      value.startsAt === undefined || value.endsAt === undefined || value.endsAt > value.startsAt,
    {
      message: 'The end date must be after the start date.',
      path: ['endsAt'],
    },
  )
  // A per-customer limit is unenforceable against guests: there is nobody to
  // count against. Requiring an account is the only way the limit means
  // anything, so the schema refuses the combination rather than letting an
  // operator configure a limit that silently does nothing.
  .refine((value) => value.maxPerCustomer === undefined || value.requiresCustomer, {
    message: 'A per-customer limit needs the code to require a signed-in customer.',
    path: ['maxPerCustomer'],
  });
export type CreateCouponInput = z.infer<typeof createCouponSchema>;

export const couponQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  activeOnly: z.coerce.boolean().optional(),
});
export type CouponQuery = z.infer<typeof couponQuerySchema>;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Starting a subscription.
 *
 * No prices. The agreed price is the catalogue price at the moment of
 * subscribing, read server-side and then held on the subscription — see the
 * note on the `Subscription` model for why it is not re-read at renewal.
 *
 * `paymentMethodId` is one of the customer's saved methods, which is a provider
 * token. There is no field here, or anywhere, that accepts a card number.
 */
export const createSubscriptionSchema = z.object({
  items: z
    .array(z.object({ variantId: uuidSchema, quantity: quantitySchema }))
    .min(1, 'A subscription needs at least one item.')
    .max(50),
  interval: z.enum(SUBSCRIPTION_INTERVALS),
  intervalCount: z.number().int().min(1).max(12).default(1),
  paymentMethodId: uuidSchema,
  shippingAddressId: uuidSchema,
  shippingMethodCode: z.string().trim().max(60).optional(),
});
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;

export const updateSubscriptionSchema = z.object({
  paymentMethodId: uuidSchema.optional(),
  shippingAddressId: uuidSchema.optional(),
  shippingMethodCode: z.string().trim().max(60).optional(),
});
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export const pauseSubscriptionSchema = z.object({
  /** Optional. Pausing is the customer's right, not something to justify. */
  reason: z.string().trim().max(500).optional(),
});
export type PauseSubscriptionInput = z.infer<typeof pauseSubscriptionSchema>;

/**
 * Cancelling.
 *
 * The reason is optional and free text. A required reason, or a fixed list that
 * omits "it is too expensive", is a dark pattern: cancelling must not be harder
 * than subscribing was.
 */
export const cancelSubscriptionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

/**
 * Saving a payment method.
 *
 * Takes the provider's token, which the browser obtained by sending card
 * details to the provider directly. There is deliberately no `number`, no
 * `expiry` and no `cvc` on this schema and no shape in which one could be
 * passed — that is what keeps this application out of PCI DSS scope.
 */
export const attachPaymentMethodSchema = z.object({
  providerPaymentMethodId: z.string().trim().min(3).max(200),
  makeDefault: z.boolean().default(false),
});
export type AttachPaymentMethodInput = z.infer<typeof attachPaymentMethodSchema>;

export const subscriptionQuerySchema = paginationSchema.extend({
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  customerId: uuidSchema.optional(),
});
export type SubscriptionQuery = z.infer<typeof subscriptionQuerySchema>;

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/**
 * Opening a conversation.
 *
 * The topic list has no medical option, and the storefront shows the redirect
 * before the customer types rather than after they have already written out
 * their symptoms. A support inbox that invited clinical questions would collect
 * health information the business has no lawful basis to hold and no ability to
 * act on.
 */
export const createSupportThreadSchema = z.object({
  topic: z.enum(SUPPORT_TOPICS),
  subject: z.string().trim().min(3, 'Give your message a subject.').max(200),
  body: z.string().trim().min(10, 'Tell us what happened.').max(4000),
  orderId: uuidSchema.optional(),
});
export type CreateSupportThreadInput = z.infer<typeof createSupportThreadSchema>;

export const supportReplySchema = z.object({
  body: z.string().trim().min(1).max(4000),
  /**
   * Staff only. The API refuses it from a customer, and a database CHECK
   * refuses it regardless — a customer message marked internal would vanish
   * from the customer's own view of their conversation.
   */
  isInternal: z.boolean().default(false),
});
export type SupportReplyInput = z.infer<typeof supportReplySchema>;

export const supportStatusSchema = z.object({
  status: z.enum(SUPPORT_STATUSES),
  note: z.string().trim().max(1000).optional(),
});
export type SupportStatusInput = z.infer<typeof supportStatusSchema>;

export const supportQuerySchema = paginationSchema.extend({
  status: z.enum(SUPPORT_STATUSES).optional(),
  topic: z.enum(SUPPORT_TOPICS).optional(),
  customerId: uuidSchema.optional(),
});
export type SupportQuery = z.infer<typeof supportQuerySchema>;

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * Marketing preferences.
 *
 * Each change writes a consent ledger entry rather than flipping a flag, so
 * "when did they opt in, and to what?" is answerable. Transactional mail is not
 * on this schema at all: a customer cannot unsubscribe from being told their
 * order shipped, and offering the switch would imply they could.
 */
export const marketingPreferencesSchema = z.object({
  acceptsMarketingEmail: z.boolean(),
  acceptsMarketingSms: z.boolean(),
});
export type MarketingPreferencesInput = z.infer<typeof marketingPreferencesSchema>;

export const requestErasureSchema = z.object({
  /** Optional. A reason is not a condition of the right. */
  reason: z.string().trim().max(1000).optional(),
  /**
   * Typed by the customer, so it is a deliberate act rather than a mis-click on
   * something irreversible.
   */
  acknowledgement: z.literal('DELETE MY ACCOUNT', {
    errorMap: () => ({ message: 'Type DELETE MY ACCOUNT to confirm.' }),
  }),
});
export type RequestErasureInput = z.infer<typeof requestErasureSchema>;

export const decideErasureSchema = z.object({
  decision: z.enum(['COMPLETED', 'REFUSED']),
  notes: notes(
    20,
    'Record what was removed, what was kept and why. This is the response to a legal request.',
  ),
});
export type DecideErasureInput = z.infer<typeof decideErasureSchema>;

export const erasureQuerySchema = paginationSchema.extend({
  status: z.enum(ERASURE_STATUSES).optional(),
});
export type ErasureQuery = z.infer<typeof erasureQuerySchema>;
