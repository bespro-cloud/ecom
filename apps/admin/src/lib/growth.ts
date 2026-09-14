import 'server-only';
import { apiRequestOrSignIn } from './guards';

/**
 * Admin-side growth types: analytics, the blog, redirects and the SEO audit.
 *
 * One naming choice is carried to the screen deliberately. `claimPromptTerms`
 * rather than `healthClaims` — the system matched some words in a draft. It has
 * not decided the article makes a health claim, and a field called
 * `healthClaims` would read as though it had.
 *
 * A second: `uniqueVisitorsPerDaySummed` rather than `uniqueVisitors`. Visitor
 * hashes are salted per day and two days' hashes for one person are unrelated
 * by design, so a range total genuinely cannot be de-duplicated. Labelling it
 * accurately is better than a number that quietly means something else.
 */

const ADMIN = '/api/v1/admin/growth';

export interface FunnelStage {
  step: string;
  sessions: number;
  continuationRate: number | null;
  overallRate: number;
}

export interface AnalyticsOverview {
  from: string;
  to: string;
  totals: {
    sessions: number;
    uniqueVisitors: number;
    pageViews: number;
    productViews: number;
    addToCarts: number;
    orders: number;
    revenueCents: number;
    conversionRate: number;
    averageOrderValueCents: number;
  };
  funnel: FunnelStage[];
  daily: Array<{
    day: string;
    sessions: number;
    uniqueVisitors: number;
    orders: number;
    revenueCents: number;
  }>;
}

export interface ChannelRow {
  channel: string;
  sessions: number;
  orders: number;
  revenueCents: number;
  conversionRate: number;
  revenuePerSessionCents: number;
}

export interface ProductRow {
  productId: string;
  productName: string;
  productSlug: string;
  views: number;
  addToCarts: number;
  unitsOrdered: number;
  revenueCents: number;
  addToCartRate: number;
}

export async function fetchOverview(range?: string): Promise<AnalyticsOverview> {
  return apiRequestOrSignIn<AnalyticsOverview>(
    `${ADMIN}/analytics/overview${range ? `?${range}` : ''}`,
  );
}

export async function fetchChannels(range?: string): Promise<ChannelRow[]> {
  const response = await apiRequestOrSignIn<{ data: ChannelRow[] }>(
    `${ADMIN}/analytics/channels${range ? `?${range}` : ''}`,
  );
  return response.data;
}

export async function fetchTopProducts(range?: string): Promise<ProductRow[]> {
  const response = await apiRequestOrSignIn<{ data: ProductRow[] }>(
    `${ADMIN}/analytics/products${range ? `?${range}` : ''}`,
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// Blog
// ---------------------------------------------------------------------------

export type BlogStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'ARCHIVED';

export interface BlogPostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  status: BlogStatus;
  author: string;
  category: { slug: string; name: string } | null;
  productIds: string[];
  /** Whether this post is the kind that needs compliance sign-off at all. */
  needsCompliance: boolean;
  hasComplianceApproval: boolean;
  complianceApprovedAt: string | null;
  complianceApprovedBy: string | null;
  complianceNotes: string | null;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogReview {
  id: string;
  decision: 'APPROVED' | 'REJECTED';
  notes: string;
  reviewedTitle: string;
  reviewerLabel: string;
  decidedAt: string;
}

export interface BlogPostDetail extends BlogPostSummary {
  blocks: unknown;
  draft: { title: string; excerpt: string | null; blocks: unknown } | null;
  products: Array<{ id: string; slug: string; name: string; sku: string; status: string }>;
  heroMedia: { id: string; url: string; altText: string } | null;
  reviews: BlogReview[];
  /** Advisory wording matches, surfaced for the reviewer. Nothing acts on them. */
  claimPromptTerms: string[];
  /** Whether publishing would succeed right now. */
  publishable: boolean;
  approvalMatchesCurrentText: boolean;
}

export async function listBlogPosts(query = 'limit=100'): Promise<{
  data: BlogPostSummary[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${ADMIN}/blog/posts?${query}`);
}

export async function getBlogPost(id: string): Promise<BlogPostDetail> {
  return apiRequestOrSignIn<BlogPostDetail>(`${ADMIN}/blog/posts/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

export interface RedirectRow {
  id: string;
  fromPath: string;
  toPath: string;
  statusCode: number;
  isAutomatic: boolean;
  reason: string | null;
  hitCount: number;
  lastHitAt: string | null;
  isActive: boolean;
  createdByLabel: string | null;
  createdAt: string;
}

export async function listRedirects(query = 'limit=100'): Promise<{
  data: RedirectRow[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${ADMIN}/redirects?${query}`);
}

// ---------------------------------------------------------------------------
// SEO audit
// ---------------------------------------------------------------------------

export interface SeoIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  entityType: string;
  entityId: string;
  label: string;
  path: string;
}

export interface SeoAuditReport {
  checkedAt: string;
  counts: { error: number; warning: number; info: number };
  issues: SeoIssue[];
}

export async function fetchSeoAudit(): Promise<SeoAuditReport> {
  return apiRequestOrSignIn<SeoAuditReport>(`${ADMIN}/seo/audit`);
}

// ---------------------------------------------------------------------------

/** A proportion as a percentage, to one decimal place. */
export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function humanise(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
