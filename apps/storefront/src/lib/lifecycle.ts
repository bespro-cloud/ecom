import 'server-only';
import { apiRequest } from './api-client';
import { apiRequestOrSignIn } from './guards';

/**
 * Reads for the customer lifecycle pages: reviews, subscriptions, support and
 * the privacy screens.
 *
 * Anything belonging to one customer goes through `apiRequestOrSignIn`, which
 * forwards the session cookie and never caches. The only shared read here is a
 * product's published reviews, and that one is explicitly cookie-free, so a
 * cached page can never become a different customer's view.
 */

const REVIEWS_REVALIDATE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface PublishedReview {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorDisplayName: string | null;
  verifiedPurchase: boolean;
  publishedAt: string | null;
}

export interface ReviewSummary {
  count: number;
  /** Null when nothing is published: "no reviews yet" is not "zero stars". */
  average: number | null;
  distribution: Record<string, number>;
}

export interface ProductReviews {
  reviews: PublishedReview[];
  summary: ReviewSummary;
}

export async function fetchProductReviews(slug: string): Promise<ProductReviews> {
  return apiRequest<ProductReviews>(
    `/api/v1/catalogue/products/${encodeURIComponent(slug)}/reviews`,
    { forwardCookies: false, revalidate: REVIEWS_REVALIDATE_SECONDS },
  );
}

export interface OwnReview {
  id: string;
  productId: string;
  product: { id: string; name: string; slug: string } | null;
  rating: number;
  title: string | null;
  body: string;
  authorDisplayName: string;
  status: string;
  verifiedPurchase: boolean;
  /** The API's own plain-English sentence. Never re-derived here. */
  visibility: string;
  createdAt: string;
  publishedAt: string | null;
}

export async function fetchMyReviews(): Promise<OwnReview[]> {
  const response = await apiRequestOrSignIn<{ data: OwnReview[] }>('/api/v1/account/reviews');
  return response.data;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface SubscriptionItemView {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  productSlug: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
}

export interface SubscriptionView {
  id: string;
  reference: string;
  status: string;
  currency: string;
  interval: string;
  intervalCount: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextBillingAt: string | null;
  failedAttempts: number;
  lastFailureCode: string | null;
  shippingMethodCode: string | null;
  pausedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  items: SubscriptionItemView[];
  /** Goods only. Shipping and tax are computed at each renewal. */
  subtotalCents: number;
  paymentMethod: {
    id: string;
    cardBrand: string | null;
    cardLast4: string | null;
    detached: boolean;
  } | null;
}

export async function fetchMySubscriptions(): Promise<SubscriptionView[]> {
  const response = await apiRequestOrSignIn<{ data: SubscriptionView[] }>(
    '/api/v1/account/subscriptions',
  );
  return response.data;
}

export interface PaymentMethodView {
  id: string;
  provider: string;
  cardBrand: string | null;
  cardLast4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  isDefault: boolean;
  createdAt: string;
}

export async function fetchMyPaymentMethods(): Promise<PaymentMethodView[]> {
  const response = await apiRequestOrSignIn<{ data: PaymentMethodView[] }>(
    '/api/v1/account/payment-methods',
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export interface SupportThreadSummary {
  id: string;
  reference: string;
  topic: string;
  subject: string;
  status: string;
  order: { id: string; reference: string } | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface SupportMessageView {
  id: string;
  /** 'Support' or 'You'. Staff email addresses never reach the customer. */
  author: string;
  authorType: string;
  body: string;
  createdAt: string;
}

export interface SupportThreadDetail extends SupportThreadSummary {
  messages: SupportMessageView[];
}

export async function fetchMyThreads(): Promise<SupportThreadSummary[]> {
  const response = await apiRequestOrSignIn<{ data: SupportThreadSummary[] }>(
    '/api/v1/account/support',
  );
  return response.data;
}

export async function fetchMyThread(id: string): Promise<SupportThreadDetail> {
  return apiRequestOrSignIn<SupportThreadDetail>(
    `/api/v1/account/support/${encodeURIComponent(id)}`,
  );
}

export async function fetchSupportGuidance(): Promise<{ medicalRedirect: string }> {
  return apiRequestOrSignIn<{ medicalRedirect: string }>('/api/v1/account/support/guidance');
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

export interface ErasureScope {
  removed: string[];
  retained: string[];
  note: string;
}

export async function fetchErasureScope(): Promise<ErasureScope> {
  return apiRequestOrSignIn<ErasureScope>('/api/v1/account/erasure');
}

export interface ConsentRecord {
  id: string;
  type: string;
  granted: boolean;
  documentVersion: string | null;
  source: string | null;
  createdAt: string;
}

export async function fetchConsentHistory(): Promise<ConsentRecord[]> {
  const response = await apiRequestOrSignIn<{ data: ConsentRecord[] }>('/api/v1/account/consents');
  return response.data;
}

// ---------------------------------------------------------------------------
// Blog
// ---------------------------------------------------------------------------

const BLOG_REVALIDATE_SECONDS = 300;

export interface BlogPostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  publishedAt: string | null;
  author: string;
  category: { slug: string; name: string } | null;
  heroImage: { url: string; altText: string; width: number | null; height: number | null } | null;
}

export interface BlogPostDetail extends BlogPostSummary {
  blocks: unknown;
  /**
   * Products the post is about, resolved to published listings only.
   *
   * A post approved while a product was live stops linking to it once the
   * listing is withdrawn. A withdrawn listing is usually withdrawn for a
   * reason, and an article is not a back door to it.
   */
  products: Array<{ id: string; slug: string; name: string; priceCents: number }>;
}

export async function fetchBlogPosts(limit = 20): Promise<BlogPostSummary[]> {
  const response = await apiRequest<{ data: BlogPostSummary[] }>(
    `/api/v1/blog/posts?limit=${limit}`,
    { forwardCookies: false, revalidate: BLOG_REVALIDATE_SECONDS },
  );
  return response.data;
}

export async function fetchBlogPost(slug: string): Promise<BlogPostDetail> {
  return apiRequest<BlogPostDetail>(`/api/v1/blog/posts/${encodeURIComponent(slug)}`, {
    forwardCookies: false,
    revalidate: BLOG_REVALIDATE_SECONDS,
  });
}
