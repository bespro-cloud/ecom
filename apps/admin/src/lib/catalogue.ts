import 'server-only';
import { apiRequestOrSignIn } from './guards';

/**
 * Admin-side catalogue types.
 *
 * Mirrors what the API returns rather than importing the service's interfaces:
 * the console talks to an HTTP contract, and sharing internal types would let a
 * change to the service compile cleanly here while breaking the screen.
 */

export type PublishCheckState = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'NOT_YET_ENFORCED';

export interface PublishCheck {
  key: string;
  label: string;
  description: string;
  state: PublishCheckState;
  detail?: string;
  implementedInPhase: number;
}

export interface PublishReadiness {
  ready: boolean;
  checks: PublishCheck[];
  blockedBy: string[];
  notYetEnforced: string[];
}

export interface AdminProductSummary {
  id: string;
  sku: string;
  slug: string;
  name: string;
  type: string;
  status: string;
  complianceStatus: string;
  complianceReviewDueAt: string | null;
  priceCents: number;
  currency: string;
  publishedAt: string | null;
  updatedAt: string;
}

export interface AdminProduct extends AdminProductSummary {
  shortDescription: string | null;
  longDescription: string | null;
  brand: string | null;
  manufacturer: string | null;
  countryOfOrigin: string | null;
  compareAtPriceCents: number | null;
  costCents: number | null;
  complianceApprovedAt: string | null;
  taxable: boolean;
  taxCode: string | null;
  weightGrams: number | null;
  dimensionsMm: { length: number | null; width: number | null; height: number | null };
  requiresShipping: boolean;
  subscriptionEligible: boolean;
  images: Array<{
    id: string;
    mediaId: string;
    role: string;
    altText: string;
    position: number;
    url: string | null;
    width: number | null;
    height: number | null;
  }>;
  variants: Array<{
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
    priceCents: number | null;
    options: unknown;
    position: number;
    isActive: boolean;
  }>;
  categories: Array<{ id: string; slug: string; name: string; isPrimary: boolean }>;
  ingredients: Array<{
    ingredientId: string;
    name: string;
    slug: string;
    amount: string | null;
    unit: string | null;
    dailyValuePercent: string | null;
    isActive: boolean;
    position: number;
    notes: string | null;
    isAllergen: boolean;
  }>;
  warnings: Array<{ id: string; severity: string; audience: string; text: string }>;
  disclaimers: Array<{ id: string; kind: string; text: string }>;
}

export interface AdminCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  depth: number;
  position: number;
  isActive: boolean;
  productCount: number;
}

export interface AdminIngredient {
  id: string;
  slug: string;
  name: string;
  scientificName: string | null;
  commonNames: string[];
  description: string | null;
  casNumber: string | null;
  allergen: string | null;
  isAllergen: boolean;
  sources: Array<{
    id: string;
    type: string;
    description: string | null;
    originCountry: string | null;
    supplier: string | null;
    isVegan: boolean;
    isVegetarian: boolean;
  }>;
  warnings: Array<{ id: string; severity: string; audience: string; text: string }>;
  productCount: number;
}

export interface AdminMedia {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  checksum: string;
  url: string | null;
  renditions: Record<string, string>;
  createdAt: string;
}

export interface AdminPage {
  id: string;
  slug: string;
  title: string;
  status: string;
  blocks: Array<Record<string, unknown>>;
  draft: { title: string; blocks: Array<Record<string, unknown>> } | null;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
  updatedAt: string;
}

export interface ComplianceReview {
  id: string;
  productId: string;
  decision: string;
  notes: string;
  reviewerId: string;
  reviewerLabel: string;
  decidedAt: string;
  reviewDueAt: string | null;
  checklistSnapshot: unknown;
}

export interface CompliancePacket {
  product: {
    id: string;
    sku: string;
    name: string;
    type: string;
    status: string;
    complianceStatus: string;
  };
  readiness: PublishReadiness;
  history: ComplianceReview[];
}

// ---------------------------------------------------------------------------

export async function listProducts(query: string): Promise<{
  data: AdminProductSummary[];
  meta: { nextCursor: string | null; hasMore: boolean };
}> {
  return apiRequestOrSignIn(`/api/v1/admin/catalogue/products${query ? `?${query}` : ''}`);
}

export async function getProduct(id: string): Promise<AdminProduct> {
  return apiRequestOrSignIn(`/api/v1/admin/catalogue/products/${id}`);
}

export async function getReadiness(id: string): Promise<PublishReadiness> {
  return apiRequestOrSignIn(`/api/v1/admin/catalogue/products/${id}/readiness`);
}

export async function listCategories(): Promise<AdminCategory[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminCategory[] }>(
    '/api/v1/admin/catalogue/categories',
  );
  return data;
}

export async function listIngredients(search?: string): Promise<AdminIngredient[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminIngredient[] }>(
    `/api/v1/admin/catalogue/ingredients${search ? `?search=${encodeURIComponent(search)}` : ''}`,
  );
  return data;
}

export async function listMedia(): Promise<AdminMedia[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminMedia[] }>('/api/v1/media?limit=60');
  return data;
}

export async function listPages(): Promise<AdminPage[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminPage[] }>('/api/v1/content/admin/pages');
  return data;
}

export async function getPage(id: string): Promise<AdminPage> {
  return apiRequestOrSignIn(`/api/v1/content/admin/pages/${id}`);
}

export async function getCompliancePacket(productId: string): Promise<CompliancePacket> {
  return apiRequestOrSignIn(`/api/v1/compliance/products/${productId}`);
}

export async function listExpiringApprovals(
  withinDays = 30,
): Promise<Array<{ id: string; sku: string; name: string; status: string; reviewDueAt: string }>> {
  const { data } = await apiRequestOrSignIn<{
    data: Array<{ id: string; sku: string; name: string; status: string; reviewDueAt: string }>;
  }>(`/api/v1/compliance/expiring?withinDays=${withinDays}`);
  return data;
}

export async function getSeo(
  entityType: string,
  entityId: string,
): Promise<{
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  noindex: boolean;
} | null> {
  return apiRequestOrSignIn(`/api/v1/content/admin/seo/${entityType}/${entityId}`);
}
