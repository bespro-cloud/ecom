import 'server-only';
import { apiRequestOrSignIn } from './guards';

/**
 * Admin-side lifecycle types: review moderation, coupons, subscriptions,
 * support and erasure requests.
 *
 * Mirrors the HTTP contract rather than the database, as elsewhere in this app.
 * Two naming choices are carried through to the screen on purpose:
 *
 * `claimPromptTerms` rather than `healthClaims` — the system matched some
 * words. It has not decided that the review makes a health claim, and a field
 * called `healthClaims` would read as though it had.
 *
 * `redemptions` is the count of real redemption rows, not a denormalised
 * counter, because that is what the limit is actually enforced against.
 */

const ADMIN = '/api/v1/admin/lifecycle';

export interface Page<T> {
  data: T[];
  meta: { hasMore: boolean };
}

// ---------------------------------------------------------------------------
// Review moderation
// ---------------------------------------------------------------------------

export type ReviewStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'ESCALATED' | 'REMOVED';

export interface AdminReviewSummary {
  id: string;
  productId: string;
  product: { id: string; name: string; sku: string; type: string } | null;
  customerReference: string;
  rating: number;
  title: string | null;
  body: string;
  authorDisplayName: string;
  status: ReviewStatus;
  verifiedPurchase: boolean;
  /** Advisory only. Nothing in the system branches on these to decide anything. */
  claimPromptTerms: string[];
  adverseEventPromptTerms: string[];
  adverseEventFlaggedAt: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface AdminReviewDecision {
  id: string;
  fromStatus: ReviewStatus;
  toStatus: ReviewStatus;
  reason: string | null;
  /** Required on every outcome. A decision with no reasoning is not a decision. */
  notes: string;
  moderatorLabel: string;
  decidedAt: string;
}

export interface AdminReviewDetail extends AdminReviewSummary {
  customer: { id: string; reference: string };
  decisions: AdminReviewDecision[];
}

export async function listReviews(query = 'limit=100'): Promise<Page<AdminReviewSummary>> {
  return apiRequestOrSignIn<Page<AdminReviewSummary>>(`${ADMIN}/reviews?${query}`);
}

export async function getReview(id: string): Promise<AdminReviewDetail> {
  return apiRequestOrSignIn<AdminReviewDetail>(`${ADMIN}/reviews/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

export interface AdminCoupon {
  id: string;
  code: string;
  name: string;
  type: string;
  amountCents: number | null;
  basisPoints: number | null;
  minSubtotalCents: number | null;
  maxDiscountCents: number | null;
  maxRedemptions: number | null;
  maxPerCustomer: number | null;
  requiresCustomer: boolean;
  /** Counted from redemption rows, which is what the limit is enforced against. */
  redemptions: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  expired: boolean;
  exhausted: boolean;
  createdByLabel: string | null;
  createdAt: string;
}

export async function listCoupons(query = 'limit=100'): Promise<Page<AdminCoupon>> {
  return apiRequestOrSignIn<Page<AdminCoupon>>(`${ADMIN}/coupons?${query}`);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface AdminSubscriptionItem {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  productSlug: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
}

export interface AdminSubscription {
  id: string;
  reference: string;
  status: string;
  interval: string;
  intervalCount: number;
  currency: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextBillingAt: string | null;
  failedAttempts: number;
  lastFailureCode: string | null;
  shippingMethodCode: string | null;
  pausedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  items: AdminSubscriptionItem[];
  subtotalCents: number;
  paymentMethod: {
    id: string;
    cardBrand: string | null;
    cardLast4: string | null;
    detached: boolean;
  } | null;
  customerReference?: string;
}

export interface AdminSubscriptionEvent {
  id: string;
  type: string;
  message: string | null;
  actorLabel: string | null;
  isSystem: boolean;
  createdAt: string;
}

export interface AdminSubscriptionDetail extends AdminSubscription {
  events: AdminSubscriptionEvent[];
}

export async function listSubscriptions(query = 'limit=100'): Promise<Page<AdminSubscription>> {
  return apiRequestOrSignIn<Page<AdminSubscription>>(`${ADMIN}/subscriptions?${query}`);
}

export async function getSubscription(id: string): Promise<AdminSubscriptionDetail> {
  return apiRequestOrSignIn<AdminSubscriptionDetail>(
    `${ADMIN}/subscriptions/${encodeURIComponent(id)}`,
  );
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export interface AdminThreadSummary {
  id: string;
  reference: string;
  topic: string;
  subject: string;
  status: string;
  customerReference: string;
  order: { id: string; reference: string } | null;
  assignedToLabel: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface AdminThreadMessage {
  id: string;
  authorType: string;
  authorLabel: string | null;
  body: string;
  /** True for a staff note the customer never sees. */
  isInternal: boolean;
  createdAt: string;
}

export interface AdminThreadDetail {
  id: string;
  reference: string;
  topic: string;
  subject: string;
  status: string;
  customer: { id: string; reference: string };
  order: { id: string; reference: string; status: string; totalCents: number } | null;
  assignedToLabel: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  messages: AdminThreadMessage[];
}

export async function listThreads(query = 'limit=100'): Promise<Page<AdminThreadSummary>> {
  return apiRequestOrSignIn<Page<AdminThreadSummary>>(`${ADMIN}/support?${query}`);
}

export async function getThread(id: string): Promise<AdminThreadDetail> {
  return apiRequestOrSignIn<AdminThreadDetail>(`${ADMIN}/support/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Erasure requests
// ---------------------------------------------------------------------------

export interface AdminErasureRequest {
  id: string;
  status: string;
  reason: string | null;
  customerReference: string;
  customerEmail: string;
  createdAt: string;
  decidedAt: string | null;
  decidedByLabel: string | null;
}

export async function listErasureRequests(query = 'limit=100'): Promise<Page<AdminErasureRequest>> {
  return apiRequestOrSignIn<Page<AdminErasureRequest>>(`${ADMIN}/erasure-requests?${query}`);
}

// ---------------------------------------------------------------------------

export function humanise(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
